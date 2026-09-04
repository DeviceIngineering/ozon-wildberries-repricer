import { createContext, useContext, useReducer, useCallback, useMemo } from 'react';

interface SelectionState {
  selectedIds: Set<string>;
  lastClickedIndex: number | null;
}

type SelectionAction =
  | { type: 'TOGGLE'; id: string; index: number }
  | { type: 'TOGGLE_ALL'; ids: string[] }
  | { type: 'CLEAR' }
  | { type: 'SELECT_RANGE'; ids: string[]; index: number };

function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'TOGGLE': {
      const next = new Set(state.selectedIds);
      if (next.has(action.id)) {
        next.delete(action.id);
      } else {
        next.add(action.id);
      }
      return { selectedIds: next, lastClickedIndex: action.index };
    }

    case 'TOGGLE_ALL': {
      const allSelected = action.ids.every((id) => state.selectedIds.has(id));
      if (allSelected) {
        // Deselect all ids on the current page
        const next = new Set(state.selectedIds);
        action.ids.forEach((id) => next.delete(id));
        return { ...state, selectedIds: next };
      } else {
        // Select all ids
        const next = new Set(state.selectedIds);
        action.ids.forEach((id) => next.add(id));
        return { ...state, selectedIds: next };
      }
    }

    case 'CLEAR':
      return { selectedIds: new Set(), lastClickedIndex: null };

    case 'SELECT_RANGE': {
      const { ids, index } = action;
      const lastIndex = state.lastClickedIndex;
      if (lastIndex === null || ids.length === 0) {
        return state;
      }
      const from = Math.min(lastIndex, index);
      const to = Math.max(lastIndex, index);
      const next = new Set(state.selectedIds);
      for (let i = from; i <= to; i++) {
        if (ids[i] !== undefined) {
          next.add(ids[i]);
        }
      }
      return { selectedIds: next, lastClickedIndex: index };
    }

    default:
      return state;
  }
}

interface SelectionContextValue {
  selectedIds: Set<string>;
  selectedCount: number;
  isSelected: (id: string) => boolean;
  toggle: (id: string, index: number) => void;
  toggleAll: (ids: string[]) => void;
  clear: () => void;
  selectRange: (ids: string[], index: number) => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(selectionReducer, {
    selectedIds: new Set<string>(),
    lastClickedIndex: null,
  });

  const isSelected = useCallback(
    (id: string) => state.selectedIds.has(id),
    [state.selectedIds]
  );

  const toggle = useCallback((id: string, index: number) => {
    dispatch({ type: 'TOGGLE', id, index });
  }, []);

  const toggleAll = useCallback((ids: string[]) => {
    dispatch({ type: 'TOGGLE_ALL', ids });
  }, []);

  const clear = useCallback(() => {
    dispatch({ type: 'CLEAR' });
  }, []);

  const selectRange = useCallback((ids: string[], index: number) => {
    dispatch({ type: 'SELECT_RANGE', ids, index });
  }, []);

  const selectedCount = useMemo(() => state.selectedIds.size, [state.selectedIds]);

  return (
    <SelectionContext.Provider
      value={{
        selectedIds: state.selectedIds,
        selectedCount,
        isSelected,
        toggle,
        toggleAll,
        clear,
        selectRange,
      }}
    >
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error('useSelection must be used within SelectionProvider');
  }
  return ctx;
}
