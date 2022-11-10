import type { CutdownAsset } from './types.js';
import { AztecSdk, GrumpkinAddress, SdkEvent, EthereumProvider, JsonRpcProvider, sha256 } from '@aztec/sdk';
import { SdkObs } from '../alt-model/top_level_context/sdk_obs.js';
import createDebug from 'debug';
import { EventEmitter } from 'events';
import Cookie from 'js-cookie';
import { debounce, DebouncedFunc } from 'lodash';
import { Config } from '../config.js';
import { AccountFormEvent, ShieldForm, ShieldFormValues, ShieldStatus } from './account_forms/index.js';
import { AccountUtils } from './account_utils.js';
import { formatAliasInput, getAliasError } from './alias.js';
import { Database } from './database/index.js';
import { EthAccount } from './eth_account/index.js';
import { MessageType, ValueAvailability } from './form.js';
import { createSigningKeys, KeyVault } from './key_vault.js';
import { Network } from './networks.js';
import { Provider, ProviderEvent, ProviderState, ProviderStatus } from './provider.js';
import { RollupService } from './rollup_service.js';
import { UserAccount } from './user_account.js';
import { WalletId, wallets } from './wallet_providers/index.js';
import { toBaseUnits } from './units.js';
import { KNOWN_MAINNET_ASSET_ADDRESS_STRS } from '../alt-model/known_assets/known_asset_addresses.js';
import { ToastsObs } from '../alt-model/top_level_context/toasts_obs.js';
import { getRollupProviderTimeoutToast } from '../views/toasts/toast_configurations.js';
import { ToastType } from '../ui-components/index.js';

const debug = createDebug('zm:user_session');

export enum LoginMode {
  SIGNUP,
  LOGIN,
}

export enum LoginStep {
  CONNECT_WALLET,
  SET_ALIAS,
  INIT_ACCOUNT,
  CREATE_ACCOUNT,
  VALIDATE_DATA,
  RECOVER_ACCOUNT_PROOF,
  CLAIM_USERNAME,
  ADD_ACCOUNT,
  SYNC_DATA,
  DONE,
}

const undisruptiveSteps = [
  LoginStep.INIT_ACCOUNT,
  LoginStep.CREATE_ACCOUNT,
  LoginStep.VALIDATE_DATA,
  LoginStep.RECOVER_ACCOUNT_PROOF,
  LoginStep.ADD_ACCOUNT,
  LoginStep.SYNC_DATA,
];

export interface LoginState {
  step: LoginStep;
  mode: LoginMode;
  isPerformingBackgroundLogin: boolean;
  walletId?: WalletId;
  alias: string;
  aliasAvailability: ValueAvailability;
  allowToProceed: boolean; // Depreciated: this is never set to false
}

export const initialLoginState: LoginState = {
  step: LoginStep.CONNECT_WALLET,
  mode: LoginMode.SIGNUP,
  isPerformingBackgroundLogin: false,
  walletId: undefined,
  alias: '',
  aliasAvailability: ValueAvailability.INVALID,
  allowToProceed: true,
};

export interface WorldState {
  latestRollup: number;
  syncedToRollup: number;
  accountSyncedToRollup: number;
}

export const initialWorldState: WorldState = { syncedToRollup: -1, latestRollup: -1, accountSyncedToRollup: -1 };

export enum UserSessionEvent {
  VERSION_MISMATCH = 'VERSION_MISMATCH',
  UPDATED_LOGIN_STATE = 'UPDATED_LOGIN_STATE',
  UPDATED_PROVIDER = 'UPDATED_PROVIDER',
  UPDATED_PROVIDER_STATE = 'UPDATED_PROVIDER_STATE',
  UPDATED_WORLD_STATE = 'UPDATED_WORLD_STATE',
  UPDATED_USER_ACCOUNT_DATA = 'UPDATED_USER_ACCOUNT_DATA',
  UPDATED_SHIELD_FOR_ALIAS_FORM = 'UPDATED_SHIELD_FOR_ALIAS_FORM',
  SESSION_CLOSED = 'SESSION_CLOSED',
  SESSION_OPEN = 'SESSION_OPEN',
}

export interface UserSession {
  on(event: UserSessionEvent.VERSION_MISMATCH, listener: () => void): this;
  on(event: UserSessionEvent.UPDATED_LOGIN_STATE, listener: (state: LoginState) => void): this;
  on(event: UserSessionEvent.UPDATED_PROVIDER, listener: () => void): this;
  on(event: UserSessionEvent.UPDATED_PROVIDER_STATE, listener: (state: ProviderState) => void): this;
  on(event: UserSessionEvent.UPDATED_WORLD_STATE, listener: (state: WorldState) => void): this;
  on(event: UserSessionEvent.UPDATED_USER_ACCOUNT_DATA, listener: () => void): this;
  on(event: UserSessionEvent.SESSION_CLOSED, listener: () => void): this;
}

export class UserSession extends EventEmitter {
  private readonly stableEthereumProvider: EthereumProvider;
  private provider?: Provider;
  private sdk!: AztecSdk;
  private rollupService!: RollupService;
  private loginState: LoginState;
  private worldState = initialWorldState;
  private keyVault!: KeyVault;
  private shieldForAliasForm?: ShieldForm;
  private accountUtils!: AccountUtils;
  private account!: UserAccount;
  private debounceCheckAlias: DebouncedFunc<() => void>;
  private destroyed = false;
  private claimUserNameProm?: Promise<void>;

  private readonly accountProofDepositAssetId = 0;
  private readonly accountProofMinDeposit: bigint;
  private readonly debounceCheckAliasWait = 600;

  constructor(
    private readonly assets: CutdownAsset[],
    private readonly config: Config,
    private readonly sdkObs: SdkObs,
    private readonly toastsObs: ToastsObs,
    private readonly requiredNetwork: Network,
    initialLoginMode: LoginMode,
    private readonly db: Database,
    private readonly sessionCookieName: string,
    private readonly walletCacheName: string,
    private readonly shieldForAliasAmountPreselection?: bigint,
  ) {
    super();
    this.debounceCheckAlias = debounce(this.updateAliasAvailability, this.debounceCheckAliasWait);
    this.loginState = {
      ...initialLoginState,
      mode: initialLoginMode,
    };
    this.accountProofMinDeposit = toBaseUnits('0.01', assets[this.accountProofDepositAssetId].decimals);
    this.stableEthereumProvider = new JsonRpcProvider(config.ethereumHost);
  }

  getSdk(): AztecSdk | undefined {
    return this.sdk;
  }

  getProvider() {
    return this.provider;
  }

  getProviderState() {
    return this.provider?.getState();
  }

  getKeyVault(): KeyVault | undefined {
    return this.keyVault;
  }

  getStableEthereumProvider(): EthereumProvider | undefined {
    return this.stableEthereumProvider;
  }

  getRollupService(): RollupService | undefined {
    return this.rollupService;
  }

  getLoginState() {
    return this.loginState;
  }

  getWorldState() {
    return this.worldState;
  }

  getAccount() {
    return this.account;
  }

  getShieldForAliasForm() {
    return this.shieldForAliasForm;
  }

  isProcessingAction() {
    return (
      !this.destroyed && (undisruptiveSteps.indexOf(this.loginState.step) >= 0 || !!this.shieldForAliasForm?.locked)
    );
  }

  async close(message = '', toastType = ToastType.NORMAL, clearSession = true) {
    this.emitSystemMessage(message, toastType);
    if (clearSession) {
      this.clearLinkedAccountSession();
    }
    this.emit(UserSessionEvent.SESSION_CLOSED);
    await this.destroy();
  }

  async destroy() {
    this.destroyed = true;
    this.removeAllListeners();
    this.debounceCheckAlias.cancel();
    this.provider?.destroy();
    this.rollupService?.destroy();
    this.shieldForAliasForm?.destroy();
    if (this.sdk) {
      this.sdk.off(SdkEvent.UPDATED_WORLD_STATE, this.handleWorldStateChange);
      this.sdk.off(SdkEvent.UPDATED_USER_STATE, this.handleUserStateChange);
    }
    debug('Session destroyed.');
  }

  changeLoginMode(mode: LoginMode) {
    this.updateLoginState({ ...initialLoginState, mode });
    this.clearSystemMessage();
  }

  async connectWallet(walletId: WalletId) {
    if (this.loginState.walletId !== undefined) {
      debug('Duplicated call to connectWallet()');
      return;
    }

    this.updateLoginState({ walletId });

    const walletName = wallets[walletId].name;
    this.emitSystemMessage(`Connecting to ${walletName}...`);
    await this.changeWallet(walletId);
    if (!this.provider) {
      return this.abort(`Unable to connect to ${walletName}.`);
    }

    this.emitSystemMessage('Connecting to rollup provider...');

    try {
      const SETUP_SESSION_TIMEOUT = 5e3;
      const timeoutId = setTimeout(() => {
        this.toastsObs.addToast(getRollupProviderTimeoutToast());
      }, SETUP_SESSION_TIMEOUT);
      await this.setupSession(false);
      clearTimeout(timeoutId);
    } catch (e) {
      return this.abort(`Something went wrong. This shouldn't happen.`);
    }

    if (this.provider!.chainId !== this.requiredNetwork.chainId) {
      this.emitSystemMessage(
        `Please switch your wallet's network to ${this.requiredNetwork.network}...`,
        ToastType.WARNING,
      );
      while (this.provider!.chainId !== this.requiredNetwork.chainId) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (this.destroyed) {
          throw new Error('Session destroyed.');
        }
      }
    }

    try {
      const { mode } = this.loginState;
      switch (mode) {
        case LoginMode.SIGNUP:
          await this.signupWithWallet();
          break;
        case LoginMode.LOGIN:
          await this.loginWithWallet();
          break;
      }
    } catch (e) {
      this.disconnectWallet();
      this.emitSystemMessage(e.message, ToastType.ERROR);
    }
  }

  private async ensureIsntContractWallet() {
    if (!this.provider?.account) {
      throw new Error('Could not determine wallet address');
    }
    const isContract = await this.sdk.isContract(this.provider?.account);
    if (isContract) {
      throw new Error(
        'Contract wallets cannot be used to register aztec accounts. Please use an externally owned address.',
      );
    }
  }

  private async signupWithWallet() {
    await this.ensureIsntContractWallet();

    this.emitSystemMessage('Please sign the message in your wallet to create a new account...', ToastType.WARNING);

    try {
      this.keyVault = await KeyVault.create(this.provider!, this.sdk);
    } catch (e) {
      debug(e);
      throw new Error('Failed to link your account.');
    }

    const { accountPublicKey } = this.keyVault;
    const isRegistered = await this.sdk.isAccountRegistered(accountPublicKey, true);

    if (!isRegistered) {
      this.toStep(LoginStep.SET_ALIAS);
    } else {
      // Attempt to sign up with a registered wallet.
      this.updateLoginState({ mode: LoginMode.LOGIN });
      const { alias } = (await this.db.getAccount(accountPublicKey)) || {};
      if (!alias) {
        this.toStep(LoginStep.SET_ALIAS);
      } else {
        // Log in to previously logged in account.
        this.updateLoginState({ alias });
        this.toStep(LoginStep.INIT_ACCOUNT);
      }
    }
  }

  private async loginWithWallet() {
    await this.ensureIsntContractWallet();

    this.emitSystemMessage('Please sign the message in your wallet to login...', ToastType.WARNING);

    try {
      this.keyVault = await KeyVault.create(this.provider!, this.sdk);
    } catch (e) {
      debug(e);
      throw new Error('Unable to link your account.');
    }

    const { accountPublicKey } = this.keyVault;
    const isRegistered = await this.sdk.isAccountRegistered(accountPublicKey, true);

    // Attempt to log in with unknown pubKey.
    if (!isRegistered) {
      // https://github.com/AztecProtocol/aztec2-internal/pull/1179 => should appear as a toast
      // TODO - show a signup link in error message.
      throw new Error(
        'Account not registered. Please check you are using the same Ethereum wallet that you used to register your account.',
      );
    }

    // TODO - different aliases might have the same accountPublicKey
    const { alias } = (await this.db.getAccount(accountPublicKey)) || {};
    if (!alias) {
      this.toStep(LoginStep.SET_ALIAS);
    } else {
      // Log in to previously logged in account.
      this.updateLoginState({ alias });
      this.toStep(LoginStep.INIT_ACCOUNT);
    }
  }

  messageTypeToToastType(messageType?: MessageType) {
    switch (messageType) {
      case MessageType.ERROR:
        return ToastType.ERROR;
      case MessageType.TEXT:
        return ToastType.NORMAL;
      case MessageType.WARNING:
        return ToastType.WARNING;
      default:
        return ToastType.NORMAL;
    }
  }

  async changeWallet(walletId: WalletId, checkNetwork = true) {
    if (this.provider?.status === ProviderStatus.INITIALIZING) {
      debug('Cannot change wallet before the current one is initialized or destroyed.');
      return;
    }

    if (walletId === this.provider?.walletId) {
      debug('Reconnecting to the same wallet.');
      await this.provider.destroy();
    }

    const prevProvider = this.provider;
    prevProvider?.removeAllListeners();

    const { chainId, ethereumHost } = this.config;
    this.provider = new Provider(walletId, { chainId, ethereumHost });
    this.provider.on(ProviderEvent.LOG_MESSAGE, (message: string, type: MessageType) =>
      this.emitSystemMessage(message, this.messageTypeToToastType(type)),
    );
    this.provider.on(ProviderEvent.UPDATED_PROVIDER_STATE, this.handleProviderStateChange);

    try {
      this.clearWalletSession();
      await this.provider.init(checkNetwork ? this.requiredNetwork : undefined);
      this.saveWalletSession(walletId);
    } catch (e) {
      debug(e);
      await this.provider.destroy();
      this.provider = prevProvider;
    }

    this.clearSystemMessage();
    this.provider?.removeAllListeners();
    this.provider?.on(ProviderEvent.UPDATED_PROVIDER_STATE, this.handleProviderStateChange);
    if (prevProvider !== this.provider) {
      await prevProvider?.destroy();
      this.updateLoginState({ walletId });
    }
    this.shieldForAliasForm?.changeProvider(this.provider);
    this.handleProviderStateChange(this.provider?.getState());
    this.emit(UserSessionEvent.UPDATED_PROVIDER);
  }

  async disconnectWallet() {
    await this.provider?.destroy();
    this.handleProviderStateChange();
  }

  setAlias(aliasInput: string) {
    const { mode } = this.loginState;
    const isNewAlias = LoginMode.SIGNUP === mode;
    if (!isNewAlias) {
      this.clearSystemMessage();
      return this.updateLoginState({ alias: aliasInput, aliasAvailability: ValueAvailability.PENDING });
    }

    this.debounceCheckAlias.cancel();

    if (!aliasInput) {
      // Don't show error for empty input while user's still typing.
      this.clearSystemMessage();
      return this.updateLoginState({
        alias: aliasInput,
        aliasAvailability: ValueAvailability.INVALID,
      });
    }

    const error = getAliasError(aliasInput);
    if (error) {
      this.emitSystemMessage(error, ToastType.ERROR);
      return this.updateLoginState({
        alias: aliasInput,
        aliasAvailability: ValueAvailability.INVALID,
      });
    }

    this.clearSystemMessage();
    this.updateLoginState({ alias: aliasInput, aliasAvailability: ValueAvailability.PENDING });
    this.debounceCheckAlias();
  }

  async confirmAlias(aliasInput: string) {
    const { mode } = this.loginState;
    const isNewAlias = LoginMode.SIGNUP === mode;

    const error = getAliasError(aliasInput);
    if (error) {
      return this.emitSystemMessage(!isNewAlias ? 'Incorrect alias.' : error, ToastType.ERROR);
    }

    const alias = formatAliasInput(aliasInput);
    if (isNewAlias) {
      if (await this.sdk.isAliasRegistered(alias, true)) {
        return this.emitSystemMessage('This alias has been taken.', ToastType.ERROR);
      }
    } else {
      const { accountPublicKey } = this.keyVault;
      if (!(await this.sdk.isAliasRegisteredToAccount(accountPublicKey, alias, true))) {
        return this.emitSystemMessage('Incorrect alias.', ToastType.ERROR);
      }
    }

    this.toStep(LoginStep.INIT_ACCOUNT);
  }

  changeShieldForAliasForm(newInputs: Partial<ShieldFormValues>) {
    this.shieldForAliasForm!.changeValues(newInputs);
  }

  async claimUserName(isRetry?: boolean) {
    if (!this.claimUserNameProm) {
      this.claimUserNameProm = this.unguardedClaimUserName(isRetry).finally(() => {
        this.claimUserNameProm = undefined;
      });
    } else {
      debug('Duplicated call to claimUserName().');
    }
    return this.claimUserNameProm;
  }

  private async unguardedClaimUserName(isRetry?: boolean) {
    if (!this.shieldForAliasForm) {
      throw new Error('Deposit form uninitialized.');
    }

    if (!isRetry) await this.shieldForAliasForm.lock();
    if (!this.shieldForAliasForm.locked) return;

    if (!this.provider?.account) {
      this.emitSystemMessage('Wallet disconnected.', ToastType.ERROR);
      return;
    }

    const { accountPublicKey } = this.keyVault;
    // Add the user to the sdk so that the accountTx could be added for it.
    // claimUserName can now only be called for new registrations, hence there is nothing to sync
    await this.initUserAccount(accountPublicKey, false, true);

    try {
      await this.shieldForAliasForm.submit();
      if (this.shieldForAliasForm.status !== ShieldStatus.DONE) return;

      this.shieldForAliasForm.destroy();
    } catch (e) {
      debug(e);
      this.emitSystemMessage('Failed to send the proofs. Please try again later.', ToastType.ERROR);
      return;
    }

    this.toStep(LoginStep.DONE);

    this.shieldForAliasForm = undefined;
  }

  async initAccount() {
    const proceed = async (step: LoginStep) => {
      if (this.destroyed) {
        throw new Error('Sdk destroyed.');
      }

      this.toStep(step);
    };

    try {
      const { mode } = this.loginState;
      const isNewAlias = LoginMode.SIGNUP === mode;
      const { accountPublicKey } = this.keyVault;

      if (isNewAlias) {
        await proceed(LoginStep.CREATE_ACCOUNT);

        const aliasInput = this.loginState.alias;
        const alias = formatAliasInput(aliasInput);

        await this.confirmAccountKey();

        // Metamask won't show the popup if two signature requests happen one after another.
        // Wait for half a second before asking the user to sign a message again.
        await new Promise(resolve => setTimeout(resolve, 500));
        const spendingPublicKey = await this.requestSigningKey();

        await this.createShieldForAliasForm(accountPublicKey, alias, spendingPublicKey);

        await proceed(LoginStep.CLAIM_USERNAME);
      } else {
        await proceed(LoginStep.ADD_ACCOUNT);

        await this.initUserAccount(accountPublicKey, false);

        await proceed(LoginStep.SYNC_DATA);

        await this.awaitUserSynchronised(accountPublicKey);

        await proceed(LoginStep.DONE);
      }
    } catch (e) {
      debug(e);
      this.emitSystemMessage(e.message, ToastType.ERROR);
      await this.destroy();
    }
  }

  async backgroundLogin() {
    if (this.loginState.walletId !== undefined) {
      debug('Attempt to login again.');
      return;
    }

    this.updateLoginState({ isPerformingBackgroundLogin: true });

    try {
      await this.setupSession(true);

      const linkedAccount = await this.getLinkedAccountFromSession();
      if (!linkedAccount) {
        throw new Error('Account not logged in.');
      }

      const { accountPublicKey, signerAddress, alias, version } = linkedAccount;

      const isAdded = await this.sdk.userExists(accountPublicKey);
      if (!isAdded) {
        await this.db.deleteAccount(accountPublicKey);
        throw new Error('Account not added.');
      }

      const isRegistered = await this.sdk.isAccountRegistered(accountPublicKey, true);
      if (!isRegistered) {
        await this.db.deleteAccount(accountPublicKey);
        throw new Error('Account not registered.');
      }

      // accountPrivateKey won't be used in the dapp once user's been added and registered.
      const accountPrivateKey = Buffer.alloc(0);
      this.keyVault = new KeyVault(accountPrivateKey, accountPublicKey, signerAddress, version);

      this.updateLoginState({
        alias,
      });

      await this.initUserAccount(accountPublicKey);

      this.toStep(LoginStep.DONE);
    } catch (e) {
      debug(e);
      await this.close();
    }
    this.updateLoginState({ isPerformingBackgroundLogin: false });
  }

  private async reviveUserProvider() {
    const walletId = this.getWalletSession();
    if (walletId === undefined || walletId === this.provider?.walletId) return;

    const { chainId, ethereumHost } = this.config;
    const provider = new Provider(walletId, { chainId, ethereumHost });
    if (provider.connected) {
      await this.changeWallet(walletId, false);
    }
  }

  private async createShieldForAliasForm(userId: GrumpkinAddress, alias: string, spendingPublicKey: GrumpkinAddress) {
    const ethAccount = new EthAccount(
      this.provider,
      this.provider?.account,
      this.provider?.network,
      this.sdk,
      this.accountProofDepositAssetId,
      this.rollupService.supportedAssets[this.accountProofDepositAssetId].address,
      this.requiredNetwork,
    );
    this.shieldForAliasForm = new ShieldForm(
      { userId, alias },
      { asset: this.assets[this.accountProofDepositAssetId], spendableBalance: 0n },
      spendingPublicKey,
      this.provider,
      ethAccount,
      this.keyVault,
      this.sdk,
      this.stableEthereumProvider,
      this.rollupService,
      this.accountUtils,
      this.requiredNetwork,
      this.config.txAmountLimits[KNOWN_MAINNET_ASSET_ADDRESS_STRS.ETH],
      this.accountProofMinDeposit,
      this.shieldForAliasAmountPreselection,
    );
    for (const e in AccountFormEvent) {
      const event = (AccountFormEvent as any)[e];
      this.shieldForAliasForm.on(event, () => this.emit(UserSessionEvent.UPDATED_SHIELD_FOR_ALIAS_FORM));
      this.shieldForAliasForm.on(AccountFormEvent.UPDATED_FORM_VALUES, (values: ShieldFormValues) => {
        const { message, messageType } = values.submit;
        if (message !== undefined) {
          this.emitSystemMessage(message, this.messageTypeToToastType(messageType));
        }
      });
    }
    await this.shieldForAliasForm.init();
  }

  private awaitSdkCreated() {
    return new Promise<AztecSdk>(resolve => {
      if (this.sdkObs.value) {
        resolve(this.sdkObs.value);
      } else {
        const unlisten = this.sdkObs.listen(sdk => {
          if (sdk) {
            resolve(sdk);
            unlisten?.();
          }
        });
      }
    });
  }

  private async setupSession(isBackgroundLogin: boolean) {
    if (!this.db.isOpen) {
      await this.db.open();
    }

    this.sdk = await this.awaitSdkCreated();

    this.sdk.on(SdkEvent.VERSION_MISMATCH, () => {
      debug('ClientVersionMismatch detected');
      this.emit(UserSessionEvent.VERSION_MISMATCH);
    });

    // If local rollupContractAddress is empty, it is a new device or the data just got wiped out.
    if (await this.rollupContractAddressChanged()) {
      if (isBackgroundLogin) {
        throw new Error('Require data reset.');
      }
    }

    this.rollupService?.destroy();
    this.rollupService = new RollupService(this.sdk);
    await this.rollupService.init();
    this.accountUtils = new AccountUtils(this.sdk);
  }

  private async initUserAccount(userId: GrumpkinAddress, awaitSynchronised = true, noSync = false) {
    if (!(await this.sdk.userExists(userId))) {
      await this.accountUtils.addUser(this.keyVault.accountPrivateKey, noSync);
    }

    await this.reviveUserProvider();

    const { alias } = this.loginState;
    this.account = new UserAccount(userId, alias);

    await this.subscribeToSyncProgress(userId);

    this.sdk.run();

    if (awaitSynchronised) {
      await this.awaitUserSynchronised(userId);
    }

    await this.updateSession();

    this.emit(UserSessionEvent.SESSION_OPEN);
  }

  private async subscribeToSyncProgress(userId: GrumpkinAddress) {
    const {
      blockchainStatus: { nextRollupId },
    } = await this.sdk.getRemoteStatus();
    const { syncedToRollup } = await this.sdk.getLocalStatus();
    this.handleWorldStateChange(syncedToRollup, nextRollupId - 1);
    await this.handleUserStateChange(userId);
    this.sdk.on(SdkEvent.UPDATED_WORLD_STATE, this.handleWorldStateChange);
    this.sdk.on(SdkEvent.UPDATED_USER_STATE, this.handleUserStateChange);
  }

  private updateAliasAvailability = async () => {
    const aliasInput = this.loginState.alias;
    const available = !(await this.sdk.isAliasRegistered(formatAliasInput(aliasInput), true));
    if (aliasInput !== this.loginState.alias) return;

    this.updateLoginState({
      aliasAvailability: available ? ValueAvailability.VALID : ValueAvailability.INVALID,
    });
  };

  private async confirmAccountKey() {
    let isSameKey = false;
    try {
      const { signerAddress, accountPublicKey } = this.keyVault;
      while (!this.provider!.account?.equals(signerAddress)) {
        this.emitSystemMessage(
          `Please switch your wallet's account to ${signerAddress.toString().slice(0, 6)}...${signerAddress
            .toString()
            .slice(-4)}.`,
          ToastType.WARNING,
        );
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (this.destroyed) {
          throw new Error('Session destroyed.');
        }
      }

      this.emitSystemMessage(
        'Please sign the message in your wallet to create your Aztec Privacy Key...',
        ToastType.WARNING,
      );
      const newKeyVault = await KeyVault.create(this.provider!, this.sdk);
      isSameKey = accountPublicKey.equals(newKeyVault.accountPublicKey);
    } catch (e) {
      debug(e);
      throw new Error('Failed to create Aztec Privacy Key.');
    } finally {
      this.clearSystemMessage();
    }
    if (!isSameKey) {
      throw new Error(
        `Your wallet doesn't generate deterministic ECDSA signatures. Please retry creating an account with a wallet that does.`,
      );
    }
  }

  private async requestSigningKey() {
    const { signerAddress } = this.keyVault;
    while (!this.provider!.account?.equals(signerAddress)) {
      this.emitSystemMessage(
        `Please switch your wallet's account to ${signerAddress.toString().slice(0, 6)}...${signerAddress
          .toString()
          .slice(-4)}.`,
        ToastType.WARNING,
      );
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (this.destroyed) {
        throw new Error('Session destroyed.');
      }
    }

    this.emitSystemMessage(
      'Please sign the message in your wallet to create your Aztec Spending Key...',
      ToastType.WARNING,
    );
    const { publicKey } = await createSigningKeys(this.provider!, this.sdk);
    this.clearSystemMessage();
    return publicKey;
  }

  private saveWalletSession(walletId: WalletId) {
    localStorage.setItem(this.walletCacheName, `${walletId}`);
  }

  private clearWalletSession() {
    localStorage.removeItem(this.walletCacheName);
  }

  private getWalletSession() {
    const session = localStorage.getItem(this.walletCacheName);
    return session ? +session : undefined;
  }

  private async updateSession() {
    const { accountPublicKey, signerAddress, version } = this.keyVault;
    const { alias } = this.loginState;
    await this.db.addAccount({
      accountPublicKey,
      signerAddress,
      alias,
      version,
      timestamp: new Date(),
    });
    await this.setLinkedAccountToSession(accountPublicKey);
  }

  private async getLinkedAccountFromSession() {
    const session = Cookie.get(this.sessionCookieName);
    if (!session) return;

    const currentSession = Buffer.from(session, 'hex');
    const accounts = await this.db.getAccounts();
    const now = Date.now();
    const expiresIn = this.config.sessionTimeout * 86400 * 1000;
    for (const account of accounts) {
      const key = await this.generateLoginSessionKey(account.accountPublicKey);
      if (key.equals(currentSession) && account.timestamp.getTime() + expiresIn > now) {
        return account;
      }
    }
  }

  private async setLinkedAccountToSession(accountPublicKey: GrumpkinAddress) {
    const sessionKey = this.generateLoginSessionKey(accountPublicKey);
    Cookie.set(this.sessionCookieName, sessionKey.toString('hex'), { expires: this.config.sessionTimeout });
  }

  private clearLinkedAccountSession() {
    Cookie.remove(this.sessionCookieName);
  }

  private generateLoginSessionKey(accountPublicKey: GrumpkinAddress) {
    return sha256(accountPublicKey.toBuffer());
  }

  private handleWorldStateChange = (syncedToRollup: number, latestRollup: number) => {
    this.updateWorldState({ ...this.worldState, syncedToRollup, latestRollup });
  };

  private handleUserStateChange = async (userId: GrumpkinAddress) => {
    if (!this.account?.userId.equals(userId)) return;

    const accountSyncedToRollup = await this.sdk.getUserSyncedToRollup(userId);
    this.worldState = { ...this.worldState, accountSyncedToRollup };
    this.emit(UserSessionEvent.UPDATED_WORLD_STATE, this.worldState);
  };

  private handleProviderStateChange = (state?: ProviderState) => {
    if (!state || state.status === ProviderStatus.DESTROYED) {
      this.provider = undefined;
      this.shieldForAliasForm?.changeProvider();
      this.clearWalletSession();
      this.updateLoginState({ walletId: undefined });
    }
    if (this.shieldForAliasForm?.ethAccountIsStale()) {
      this.renewShieldForAliasEthAccount();
    }

    this.emit(UserSessionEvent.UPDATED_PROVIDER_STATE, state);
  };

  private renewShieldForAliasEthAccount() {
    const ethAccount = new EthAccount(
      this.provider,
      this.provider?.account,
      this.provider?.network,
      this.sdk,
      this.accountProofDepositAssetId,
      this.rollupService.supportedAssets[this.accountProofDepositAssetId].address,
      this.requiredNetwork,
    );
    this.shieldForAliasForm?.changeEthAccount(ethAccount);
  }

  private toStep(step: LoginStep, message = '', toastType = ToastType.NORMAL) {
    this.updateLoginState({ step });
    this.emitSystemMessage(message, toastType);
  }

  private async abort(message = '', toastType = ToastType.ERROR) {
    const { step } = this.loginState;
    switch (step) {
      case LoginStep.CONNECT_WALLET:
        this.updateLoginState({ walletId: undefined });
        break;
    }
    this.emitSystemMessage(message, toastType);
    this.emit(UserSessionEvent.SESSION_CLOSED);
    await this.destroy();
  }

  private updateWorldState = (worldState: WorldState) => {
    this.worldState = worldState;
    this.emit(UserSessionEvent.UPDATED_WORLD_STATE, worldState);
  };

  private updateLoginState(loginState: Partial<LoginState>) {
    this.loginState = { ...this.loginState, ...loginState };
    this.emit(UserSessionEvent.UPDATED_LOGIN_STATE, this.loginState);
  }

  private clearSystemMessage() {
    this.toastsObs.removeToastByKey('system-message');
  }

  private emitSystemMessage(text = '', type = ToastType.NORMAL) {
    if (text.length === 0) {
      this.clearSystemMessage();
      return;
    }
    this.toastsObs.addOrReplaceToast({
      text,
      type,
      isClosable: false,
      key: 'system-message',
    });
  }

  private async awaitUserSynchronised(userId: GrumpkinAddress) {
    // Timeout every second so that we can stop this loop when the session is destroyed.
    const timeout = 1;
    while (!this.destroyed) {
      try {
        await this.sdk.awaitUserSynchronised(userId, timeout);
        return;
      } catch (e) {
        // timeout
      }
    }
    throw new Error('Session destroyed.');
  }

  private async rollupContractAddressChanged() {
    const {
      blockchainStatus: { rollupContractAddress },
    } = await this.sdk.getRemoteStatus();
    const remoteRollupContractAddress = rollupContractAddress.toString();
    const localRollupContractAddress = localStorage.getItem('rollupContractAddress');
    localStorage.setItem('rollupContractAddress', remoteRollupContractAddress);
    return localRollupContractAddress && localRollupContractAddress !== remoteRollupContractAddress;
  }
}