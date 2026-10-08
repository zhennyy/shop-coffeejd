// Стартовые данные для пустой базы: тарифы доставки и демо-товары
const { database } = require('./index');

const STARTER_DELIVERY_RATES = [
  { city: 'Санкт-Петербург', city_en: 'Saint Petersburg', price: 40000 },
  { city: 'Москва', city_en: 'Moscow', price: 70000 },
  { city: 'Великий Новгород', city_en: 'Veliky Novgorod', price: 70000 },
  { city: 'Псков', city_en: 'Pskov', price: 70000 },
  { city: 'Петрозаводск', city_en: 'Petrozavodsk', price: 70000 },
  { city: 'Вологда', city_en: 'Vologda', price: 70000 },
];

// Кофе в двух фасовках: 250 г и 1 кг — варианты одной карточки (group_key)
const STARTER_COFFEES = [
  { name: 'Эфиопия Иргачефф', nameEn: 'Ethiopia Yirgacheffe', description: 'Светлая обжарка: жасмин, бергамот, чёрный чай', descriptionEn: 'Light roast: jasmine, bergamot, black tea', price250g: 120000, price1kg: 420000 },
  { name: 'Колумбия Супремо', nameEn: 'Colombia Supremo', description: 'Средняя обжарка: шоколад, орех, карамель', descriptionEn: 'Medium roast: chocolate, nuts, caramel', price250g: 95000, price1kg: 340000 },
  { name: 'Бразилия Сантос', nameEn: 'Brazil Santos', description: 'Тёмная обжарка для эспрессо: какао, пряности', descriptionEn: 'Dark espresso roast: cocoa, spices', price250g: 80000, price1kg: 290000 },
];

async function seedDeliveryRates() {
  if (await database.deliveryRate.count()) return;
  await database.deliveryRate.createMany({ data: STARTER_DELIVERY_RATES });
}

async function seedProducts() {
  if (await database.product.count()) return;
  const starterProducts = [];
  for (const coffee of STARTER_COFFEES) {
    const shared = { description: coffee.description, description_en: coffee.descriptionEn, category: 'Кофе', category_en: 'Coffee', group_key: coffee.name };
    starterProducts.push(
      { ...shared, name: `${coffee.name} · 250 г`, name_en: `${coffee.nameEn} · 250 g`, price: coffee.price250g, stock: 40, option_label: '250 г', option_label_en: '250 g' },
      { ...shared, name: `${coffee.name} · 1 кг`, name_en: `${coffee.nameEn} · 1 kg`, price: coffee.price1kg, stock: 15, option_label: '1 кг', option_label_en: '1 kg' },
    );
  }
  starterProducts.push(
    { name: 'Набор «Дегустация»', description: 'Три сорта по 100 г: светлая, средняя и тёмная обжарка', price: 190000, stock: 25, category: 'Наборы',
      name_en: 'Tasting set', description_en: 'Three roasts, 100 g each: light, medium, dark', category_en: 'Sets' },
    { name: 'Улун Те Гуан Инь', description: 'Классический улун с цветочным ароматом. 100 г', price: 70000, stock: 30, category: 'Чай',
      name_en: 'Tie Guan Yin oolong', description_en: 'Classic floral oolong. 100 g', category_en: 'Tea' },
  );
  await database.product.createMany({ data: starterProducts });
}

async function seedDatabase() {
  await seedDeliveryRates();
  await seedProducts();
}

module.exports = { seedDatabase };
