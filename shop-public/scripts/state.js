// Общее состояние витрины: каталог, корзина, язык, фильтры, открытая вкладка, флаги владелицы.
// Один изменяемый объект: модули читают и меняют его поля, после изменений сами вызывают нужную перерисовку.

export const state = {
  language: 'ru', // 'ru' | 'en'
  products: [], // товары с сервера (вместе с допами — у них is_addon)
  cart: {}, // id товара → количество (штуки или граммы/мл для товаров на вес)
  shopInfo: null, // условия доставки и оплаты (/checkout-info), грузятся в фоне

  // каталог
  selectedCategory: null, // null — «Все»
  searchQuery: '',
  sortOrder: '', // '' — популярные, 'asc' — дешевле, 'desc' — дороже
  onlyInStock: false,
  openProductId: null, // товар в открытой шторке

  activeTab: 'catalog', // catalog | cart | checkout | orders | ai | admin
  orders: null, // заказы покупателя («Мои заказы»)
  subscriptionIntervals: undefined, // варианты «повторять раз в N дней» с сервера

  isOwner: false, // владелица видит вкладку «Админка»
  startTabOpened: false, // вкладка из ссылки (?tab=…) открывается только при первой загрузке
};
