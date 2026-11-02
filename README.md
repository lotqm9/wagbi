# wagbi

The first fully prompted coin builder: [wagbi.fun](https://wagbi.fun)

You chat with it like you would with Claude. Type a coin idea in one sentence, paste a tweet, or drop in a picture, and it makes the whole coin: two designs to pick from (name, $TICKER, bio, logo, X banner), and a website for the coin at wagbi.fun/<name>. Keep chatting to change any part as many times as you want. Making and changing coins is free. When it looks right, launch it on pump.fun, Raydium LaunchLab or Meteora from the same chat.

## How it works

- **The maker** (`api/make.js`, `api/_lib/maker.js`): Claude reads the idea, searches the web and reads links when it helps, finds the original picture when you name a real meme (`api/_lib/refs.js`), and writes two designs from two different angles, streaming its thinking and each step to the page. Each design picks an art direction from `api/_lib/art.js`; the pictures are painted by an image model (`api/_lib/kie.js`, `api/_lib/images.js`) and the coin's name is set in a real font afterwards (`api/_lib/type.js`). A second look checks every picture and redraws the ones that miss. If the image model is down, Claude draws the coin as SVG instead (`api/_lib/engine.js`).
- **The "+" menu**: attach pictures (`api/upload.js`), read a link (posts on X and any page, `api/_lib/links.js`), and web search.
- **Coin websites** (`api/_lib/sites.js`, `coin-site/`): every coin gets its own site with its own look, the CA once it's live, live market numbers and how to buy. It shows up live inside the chat and goes into the token's metadata as its website.
- **Launching** (`api/launch.js`, `api/_lib/launch/`): no wallet connection. You send SOL to a one-time deposit address; the coin launches, any leftover SOL comes back, and a failed launch is refunded. On pump.fun the creator fees are split and locked on chain (wagbi 15%, the rest to the wallets you choose); on the other launchpads you keep the creator fees.
- **Coins tab** (`api/coins.js`): every launched coin with live market cap, volume and curve progress, then every coin made.
- **Accounts**: sign in with Google to keep your chats on every device (`api/auth.js`).

## Notes

- The on-chain launch core is a private package (`printer-engine`) and is not included here.
- Configuration is by environment variables; nothing secret lives in this repo.
- Tests: `npm test`.
