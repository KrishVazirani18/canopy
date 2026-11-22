import express from 'express';
import { loadOrders } from './orders.js';

const app = express();
app.get('/api/orders', async (req, res) => {
  const orders = await loadOrders();
  const limit = Number(req.query.limit ?? 50);
  res.json(orders.slice(0, limit).map((o) => ({ id: o.id, total: o.items.reduce((n, i) => n + i.price * i.qty, 0) })));
});
app.listen(3000);
