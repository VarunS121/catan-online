# 🏝️ Catan Online

Private, real-time Catan for you and your friends in the browser. It supports the base game (2–4 players) and the 5–6 player extension, with no accounts.

## Rules implemented

- **Board.** The board is random each game. The base board has 19 hexes and 9 harbors. The 5–6 player board has 30 hexes, 2 deserts and 11 harbors. Number tokens are placed so 6s and 8s never touch, and no two equal numbers touch.
- **Setup.** Players place in snake order (1→N, then N→1), and the distance rule applies. Each road must touch the settlement just placed. Your second settlement pays out its adjacent resources.
- **Production.** A settlement collects 1 and a city collects 2, and the robber blocks its hex. The official bank-shortage rule applies: if the bank can't pay everyone owed a resource, nobody gets it, unless only one player is owed, who then takes what's left.
- **Rolling a 7.** Everyone holding more than 7 cards (the host can change this limit) discards half, rounded down. The roller then must move the robber to a different hex and steals a random card from a player who has a building there and holds cards.
- **Building.**
  - Roads must connect to your network, and an opponent's building blocks a connection through its corner.
  - Settlements need your road and must be 2 spaces from any other building.
  - Cities upgrade a settlement, and that settlement piece goes back to your supply.
  - Each player has 15 roads, 5 settlements and 4 cities.
- **Development cards.**
  - The deck is 14 knights, 5 VP, 2 Road Building, 2 Year of Plenty and 2 Monopoly. The 5–6 deck is 20/5/3/3/3.
  - You can play one card per turn, at any time during your turn, including before rolling.
  - You can't play a card on the turn you bought it.
  - VP cards stay hidden until the game ends.
- **Longest Road.** You need 5 or more connected segments, and opponents' settlements can break a road. If the holder ties, they keep it. If several players tie after the holder's road is broken, nobody holds it.
- **Largest Army.** You need 3 or more knights, and must have strictly more than the current holder to take it.
- **Trading.**
  - Bank trades are 4:1, or 3:1 and 2:1 with harbors.
  - Domestic trades happen only with the active player, after the roll. The active player can offer to everyone or to one player, and others can make counter-offers. Gifts and like-for-like trades aren't allowed.
- **5–6 players.** After each turn there's a **Special Building Phase**: every other player, in order, may build or buy development cards, but can't trade or play cards.
- **Winning.** The game ends when someone reaches 10 VP (the host can choose 8–14), and only on your own turn. Points gained on someone else's turn count at the start of yours.

## Game settings (host, in the waiting room)

- **Board:** 3–4 players or 5–6 players.
- **Points to win:** 8, 10, 12 or 14.
- **Turn timer:** off, 1, 1½, 2, 3 or 5 minutes. When time runs out the game makes a move for whoever it's waiting on:
  - during setup it places the settlement on the best-producing spot and a random road;
  - before the roll it rolls and then ends the turn;
  - after the roll it ends the turn;
  - otherwise it discards random cards, moves the robber off your own hexes and steals, or places your free roads.

  Building and trading after the roll share one countdown, so playing a card doesn't reset the clock.
- **Discard limit:** on a 7, players holding more than 7 (standard), 8, 9, 10 or 12 cards discard half.
- **Bank card counts:** shown or hidden. When hidden, nobody sees how many resource cards are left in the bank until the game ends. The development deck count stays visible.

The server is authoritative: it validates every action, and each player receives only their own hand. Other players' hands and the development deck stay hidden.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000, create a game and share the invite link. Friends on the same Wi-Fi can use `http://<your-local-IP>:3000`.

**Over the internet, without deploying:** keep `npm start` running and use a free tunnel such as `cloudflared tunnel --url http://localhost:3000`, then share the `https://…trycloudflare.com` link.

**Deploy:** the repo includes a `render.yaml` blueprint, so you can push it to GitHub and create a new Blueprint on [Render](https://render.com). WebSockets work on the free plan. Note that a free instance sleeps when idle and forgets games in progress when it restarts.

## Tests

```bash
npm test
```

- `test/rules.test.js` checks specific rules on hand-built positions: setup, distance rule, road blocking, longest-road breaks and ties, bank shortage, discards and the discard limit, dev-card timing, trades, harbors, win timing, the special building phase, the hidden bank, and the turn timer (including a game where nobody ever acts).
- `test/sim.js` plays dozens of complete random games on both boards and checks the invariants after every action: resources are conserved, the piece supply is correct and the distance rule holds.
- `test/socket.test.js` covers create, join, start, setup, reconnect and spectating over real WebSockets.
