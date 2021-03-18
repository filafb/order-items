import { useContext, createContext } from 'react';

import {
  AssemblyOptionInput,
  BaseOrderForm,
  CatalogItem,
  Item,
  MarketingData,
  OrderForm,
  OrderFormItemInput,
  Totalizer,
} from '../../types';

interface Context {
  addItem: (
    items: Array<Partial<CatalogItem>>,
    marketingData?: Partial<MarketingData>,
    salesChannel?: string
  ) => void;
  updateQuantity: (props: Partial<CatalogItem>) => void;
  removeItem: (props: Partial<CatalogItem>) => void;
}

const noop = async () => {};

export const OrderItemsContext = createContext<Context>({
  addItem: noop,
  updateQuantity: noop,
  removeItem: noop,
});

export const useOrderItems = () => {
  return useContext(OrderItemsContext);
};