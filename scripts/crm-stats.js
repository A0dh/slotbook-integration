// Prints what the mock CRM has received so far.   npm run crm:stats

const url = new URL('/stats', process.env.CRM_URL ?? 'http://localhost:4010');
const res = await fetch(url, { headers: { 'x-api-key': process.env.CRM_API_KEY ?? '' } });
console.log(JSON.stringify(await res.json(), null, 2));
