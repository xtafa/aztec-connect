import type { DefiRecipe } from 'alt-model/defi/types';
import { useState } from 'react';
import { Toggle } from 'components';
import { TokenList } from './token_list';
import style from './holdings_list.module.scss';
import { DefiInvestments } from 'components/defi_investments';
import { useBalances } from 'alt-model';
import { useOpenPositions } from 'alt-model/defi/open_position_hooks';

const VIEWS = [
  { label: 'Tokens', value: 'tokens' },
  { label: 'Earn Positions', value: 'defi-positions' },
];

type View = typeof VIEWS[number]['value'];

interface HoldingsListProps {
  onOpenDefiExitModal: (recipe: DefiRecipe) => void;
  onOpenShieldModal: (assetId: number) => void;
  onOpenSendModal: (assetId: number) => void;
}

export function HoldingsList(props: HoldingsListProps) {
  const [view, setView] = useState<View>('tokens');
  const balances = useBalances();
  const positions = useOpenPositions();

  return (
    <div className={style.holdingsListWrapper}>
      <div className={style.speedSwitchWrapper}>
        <Toggle options={VIEWS} value={view} onChangeValue={setView} />
      </div>
      <>
        {view === 'tokens' ? (
          <TokenList
            balances={balances}
            onOpenShieldModal={props.onOpenShieldModal}
            onOpenSendModal={props.onOpenSendModal}
          />
        ) : (
          <DefiInvestments positions={positions} onOpenDefiExitModal={props.onOpenDefiExitModal} />
        )}
      </>
    </div>
  );
}
