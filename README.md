# Sanal Ekonomi V17

V17 starter/auth repair release.

- Existing broken accounts with all economy values and land at 0 are repaired on `/me`.
- Repair restores 5,000 SCoin, 300 iron, 400 wood, 400 stone, 200 energy and 4 land.
- Starter buildings are ensured: Warehouse, Mine, Sawmill, Quarry.
- New registration explicitly writes the starter balances instead of relying on database defaults.
- Existing PostgreSQL database is preserved.

Environment variables: `DATABASE_URL`, `JWT_SECRET`.
Start: `npm start`.
