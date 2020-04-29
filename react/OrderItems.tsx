import React, {
  createContext,
  FC,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useEffect,
} from 'react'
import { useMutation } from 'react-apollo'
import UpdateItems from 'vtex.checkout-resources/MutationUpdateItems'
import AddToCart from 'vtex.checkout-resources/MutationAddToCart'
import { OrderForm, OrderQueue } from 'vtex.order-manager'
import { Item } from 'vtex.checkout-graphql'

import {
  LocalOrderTaskType,
  getLocalOrderQueue,
  popLocalOrderQueue,
  pushLocalOrderQueue,
  updateLocalQueueItemIds,
  UpdateQuantityInput,
} from './modules/localOrderQueue'
import {
  adjustForItemInput,
  mapItemInputToOrderFormItem,
  AVAILABLE,
} from './utils'

const { useOrderForm } = OrderForm
const { useOrderQueue, useQueueStatus, QueueStatus } = OrderQueue

interface Context {
  addItem: (
    items: Array<Partial<CatalogItem>>,
    marketingData?: Partial<MarketingData>
  ) => void
  updateQuantity: (props: Partial<Item>) => void
  removeItem: (props: Partial<Item>) => void
}

enum Totalizers {
  SUBTOTAL = 'Items',
  DISCOUNT = 'Discounts',
}

const updateTotalizersAndValue = ({
  totalizers,
  currentValue = 0,
  newItem,
  oldItem,
}: {
  totalizers: Totalizer[]
  currentValue?: number
  newItem: Item
  oldItem?: Item
}) => {
  if (oldItem?.availability !== AVAILABLE) {
    return { totalizers, value: currentValue }
  }

  const oldItemPrice = oldItem.price ?? 0
  const oldItemQuantity = oldItem.quantity ?? 0
  const oldItemSellingPrice = oldItem.sellingPrice ?? 0

  const oldPrice = oldItemPrice * oldItemQuantity
  const newPrice = newItem.price! * newItem.quantity
  const subtotalDifference = newPrice - oldPrice

  const oldDiscount = (oldItemSellingPrice - oldItemPrice) * oldItemQuantity
  const newDiscount =
    (newItem.sellingPrice! - newItem.price!) * newItem.quantity
  const discountDifference = newDiscount - oldDiscount

  const updatedValue = currentValue + subtotalDifference + discountDifference

  if (!totalizers.length) {
    return {
      totalizers: [
        {
          id: Totalizers.SUBTOTAL,
          name: 'Items Total',
          value: subtotalDifference,
        },
        {
          id: Totalizers.DISCOUNT,
          name: 'Discounts Total',
          value: discountDifference,
        },
      ],
      value: updatedValue,
    }
  }

  const newTotalizers = totalizers.map(totalizer => {
    switch (totalizer.id) {
      case Totalizers.SUBTOTAL:
        return {
          ...totalizer,
          value: totalizer.value + subtotalDifference,
        }
      case Totalizers.DISCOUNT:
        return {
          ...totalizer,
          value: totalizer.value + discountDifference,
        }
      default:
        return totalizer
    }
  })

  return {
    totalizers: newTotalizers,
    value: updatedValue,
  }
}

const addToTotalizers = (totalizers: Totalizer[], item: Item): Totalizer[] => {
  return updateTotalizersAndValue({ totalizers, newItem: item }).totalizers
}

const noop = async () => {}

const OrderItemsContext = createContext<Context>({
  addItem: noop,
  updateQuantity: noop,
  removeItem: noop,
})

interface Task {
  execute: () => Promise<OrderForm>
  rollback: () => void
}

const useEnqueueTask = () => {
  const { enqueue, listen } = useOrderQueue()
  const queueStatusRef = useQueueStatus(listen)
  const { setOrderForm } = useOrderForm()

  const enqueueTask = useCallback<(task: Task) => PromiseLike<void>>(
    task =>
      enqueue(task.execute).then(
        (orderForm: OrderForm) => {
          popLocalOrderQueue()
          if (queueStatusRef.current === QueueStatus.FULFILLED) {
            setOrderForm(orderForm)
          }
        },
        (error: any) => {
          popLocalOrderQueue()

          if (error && error.code === 'TASK_CANCELLED') {
            return
          }

          task.rollback()
          throw error
        }
      ),
    [enqueue, queueStatusRef, setOrderForm]
  )

  return enqueueTask
}

const useAddItemsTask = (
  fakeUniqueIdMapRef: React.MutableRefObject<FakeUniqueIdMap>
) => {
  const [mutateAddItem] = useMutation<
    { addToCart: OrderForm },
    { items: OrderFormItemInput[]; marketingData?: Partial<MarketingData> }
  >(AddToCart)
  const { setOrderForm } = useOrderForm()

  const addItemTask = useCallback(
    ({
      mutationInputItems,
      mutationInputMarketingData,
      orderFormItems,
    }: {
      mutationInputItems: OrderFormItemInput[]
      mutationInputMarketingData?: Partial<MarketingData>
      orderFormItems: Item[]
    }) => ({
      execute: async () => {
        const { data } = await mutateAddItem({
          variables: {
            items: mutationInputItems,
            marketingData: mutationInputMarketingData,
          },
        })

        const updatedOrderForm = data!.addToCart
        // update the uniqueId of the items that were
        // added locally with the value from the server
        orderFormItems.forEach(orderFormItem => {
          const updatedItem = updatedOrderForm.items.find(
            updatedOrderFormItem => updatedOrderFormItem.id === orderFormItem.id
          )!

          const fakeUniqueId = orderFormItem.uniqueId

          // update all mutations in the queue that referenced
          // this item with it's fake `uniqueId`
          updateLocalQueueItemIds({
            fakeUniqueId,
            uniqueId: updatedItem.uniqueId,
          })
          fakeUniqueIdMapRef.current[fakeUniqueId] = updatedItem.uniqueId
        })

        // update the `uniqueId` in the remaining items on local orderForm
        setOrderForm(prevOrderForm => {
          return {
            ...prevOrderForm,
            items: prevOrderForm.items.map(item => {
              const inputIndex = mutationInputItems.findIndex(
                inputItem => inputItem.id === +item.id
              )

              if (inputIndex === -1) {
                // this item wasn't part of the initial mutation, skip it
                return item
              }

              const updatedItem = updatedOrderForm.items.find(
                updatedOrderFormItem => updatedOrderFormItem.id === item.id
              )!

              return {
                ...item,
                uniqueId: updatedItem.uniqueId,
              }
            }),
            marketingData:
              mutationInputMarketingData ?? prevOrderForm.marketingData,
          }
        })

        return updatedOrderForm
      },
      rollback: () => {
        setOrderForm(prevOrderForm => {
          const itemIds = mutationInputItems.map(({ id }) => id!.toString())
          return {
            ...prevOrderForm,
            items: prevOrderForm.items.filter(orderFormItem => {
              return !itemIds.includes(orderFormItem.id)
            }),
          }
        })
      },
    }),
    [fakeUniqueIdMapRef, mutateAddItem, setOrderForm]
  )

  return addItemTask
}

const useUpdateItemsTask = (
  fakeUniqueIdMapRef: React.MutableRefObject<FakeUniqueIdMap>
) => {
  const [mutateUpdateQuantity] = useMutation<UpdateItemsMutation>(UpdateItems)

  const updateItemTask = useCallback(
    ({ items }: { items: UpdateQuantityInput[] }) => ({
      execute: async () => {
        const mutationVariables = {
          orderItems: items.map(input => {
            if ('uniqueId' in input) {
              // here we need to update the uniqueId again in the mutation
              // because it may have been a "fake" `uniqueId` that were generated
              // locally so we could manage the items when offline.
              //
              // so, we will read the value using the `fakeUniqueIdMapRef` because
              // it maps a fake `uniqueId` to a real `uniqueId` that was generated by
              // the API. if it doesn't contain the value, we will assume that this uniqueId
              // is a real one.
              const uniqueId =
                fakeUniqueIdMapRef.current[input.uniqueId] || input.uniqueId

              return { uniqueId, quantity: input.quantity }
            }

            return input
          }),
        }

        const { data } = await mutateUpdateQuantity({
          variables: mutationVariables,
        })

        return data!.updateItems
      },
      rollback: () => {},
    }),
    [fakeUniqueIdMapRef, mutateUpdateQuantity]
  )

  return updateItemTask
}

interface FakeUniqueIdMap {
  [fakeUniqueId: string]: string
}

const useFakeUniqueIdMap = () => {
  const fakeUniqueIdMapRef = useRef<FakeUniqueIdMap>({})
  const { listen } = useOrderQueue()

  useEffect(
    () =>
      listen(QueueStatus.FULFILLED, () => {
        // avoid leaking "fake" `uniqueId`.
        // this works because everytime we fulfill the queue, we know
        // for sure that we won't have any locally generated uniqueId's
        // left to map to a real uniqueId.
        fakeUniqueIdMapRef.current = {}
      }),
    [listen]
  )

  return fakeUniqueIdMapRef
}

interface UpdateItemsMutation {
  updateItems: OrderForm
}

export const OrderItemsProvider: FC = ({ children }) => {
  const { orderForm, setOrderForm } = useOrderForm()

  const fakeUniqueIdMapRef = useFakeUniqueIdMap()

  const enqueueTask = useEnqueueTask()
  const addItemsTask = useAddItemsTask(fakeUniqueIdMapRef)
  const updateItemsTask = useUpdateItemsTask(fakeUniqueIdMapRef)

  const orderFormItemsRef = useRef(orderForm.items)

  useEffect(() => {
    orderFormItemsRef.current = orderForm.items
  }, [orderForm.items])

  /**
   * Add the items to the order form.
   *
   * Returns if the items were added or not.
   */
  const addItem = useCallback(
    (
      items: Array<Partial<CatalogItem>>,
      marketingData?: Partial<MarketingData>
    ) => {
      const mutationInputItems = items
        .map(adjustForItemInput)
        .filter(
          itemInput =>
            orderFormItemsRef.current.findIndex(
              orderFormItem => itemInput.id!.toString() === orderFormItem.id
            ) === -1
        )

      const orderFormItems = mutationInputItems
        .map((itemInput, index) =>
          mapItemInputToOrderFormItem(itemInput, items[index])
        )
        .filter(
          orderFormItem =>
            orderFormItemsRef.current.findIndex(
              (item: any) => item.id === orderFormItem.id
            ) === -1
        )

      if (orderFormItems.length === 0) {
        // all items already exist in the cart
        return false
      }

      setOrderForm(prevOrderForm => ({
        ...prevOrderForm,
        items: [...orderFormItemsRef.current, ...orderFormItems],
        totalizers: orderFormItems.reduce(
          addToTotalizers,
          (prevOrderForm.totalizers as Totalizer[]) ?? []
        ),
        marketingData: marketingData ?? prevOrderForm.marketingData,
        value:
          prevOrderForm.value +
          orderFormItems.reduce(
            (total, item) => total + item.sellingPrice! * item.quantity,
            0
          ),
      }))

      pushLocalOrderQueue({
        type: LocalOrderTaskType.ADD_MUTATION,
        variables: {
          items: mutationInputItems,
          marketingData,
        },
        orderFormItems,
      })

      enqueueTask(
        addItemsTask({
          mutationInputItems,
          mutationInputMarketingData: marketingData,
          orderFormItems,
        })
      )

      return true
    },
    [addItemsTask, enqueueTask, setOrderForm]
  )

  const updateQuantity = useCallback(
    input => {
      let index: number
      let uniqueId = ''

      if (input.id) {
        index = orderFormItemsRef.current.findIndex(
          (orderItem: any) => orderItem.id === input.id
        )
      } else if ('uniqueId' in input) {
        uniqueId = input.uniqueId
        index = orderFormItemsRef.current.findIndex(
          (orderItem: any) => orderItem.uniqueId === input.uniqueId
        )
      } else {
        index = input.index ?? -1
      }

      if (index < 0 || index >= orderFormItemsRef.current.length) {
        throw new Error(`Item ${input.id || input.uniqueId} not found`)
      }

      if (!uniqueId) {
        uniqueId = orderFormItemsRef.current[index].uniqueId
      }

      const quantity = input.quantity ?? 1

      setOrderForm(prevOrderForm => {
        const updatedItems = prevOrderForm.items.slice()

        const oldItem = updatedItems[index]
        const newItem = {
          ...oldItem,
          quantity,
        }

        if (quantity > 0) {
          updatedItems[index] = newItem
        } else {
          updatedItems.splice(index, 1)
        }

        return {
          ...prevOrderForm,
          ...updateTotalizersAndValue({
            totalizers: prevOrderForm.totalizers as Totalizer[],
            currentValue: prevOrderForm.value,
            newItem,
            oldItem,
          }),
          items: updatedItems,
        }
      })

      const mutationVariables = {
        orderItems: [{ uniqueId, quantity }],
      }

      pushLocalOrderQueue({
        type: LocalOrderTaskType.UPDATE_MUTATION,
        variables: mutationVariables,
      })

      enqueueTask(updateItemsTask({ items: mutationVariables.orderItems }))
    },
    [enqueueTask, setOrderForm, updateItemsTask]
  )

  const removeItem = useCallback(
    (props: Partial<Item>) => updateQuantity({ ...props, quantity: 0 }),
    [updateQuantity]
  )

  const value = useMemo(() => ({ addItem, updateQuantity, removeItem }), [
    addItem,
    updateQuantity,
    removeItem,
  ])

  useEffect(() => {
    const localOrderQueue = getLocalOrderQueue()

    localOrderQueue.queue.forEach(task => {
      if (task.type === LocalOrderTaskType.ADD_MUTATION) {
        enqueueTask(
          addItemsTask({
            mutationInputItems: task.variables.items,
            mutationInputMarketingData: task.variables.marketingData,
            orderFormItems: task.orderFormItems,
          })
        )
      } else if (task.type === LocalOrderTaskType.UPDATE_MUTATION) {
        enqueueTask(updateItemsTask({ items: task.variables.orderItems }))
      }
    })
  }, [addItemsTask, enqueueTask, updateItemsTask])

  return (
    <OrderItemsContext.Provider value={value}>
      {children}
    </OrderItemsContext.Provider>
  )
}

export const useOrderItems = () => {
  return useContext(OrderItemsContext)
}

export default { OrderItemsProvider, useOrderItems }
