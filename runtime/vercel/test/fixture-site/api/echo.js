export default async function handler(req, res) {
  res.setHeader('X-Test', '1');
  return res.status(201).json({ method: req.method, query: req.query, body: req.body, cookie: req.cookies.a });
}
