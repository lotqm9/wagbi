# wagbi

The first fully prompted coin builder. Type a sentence, get a coin: [wagbi.fun](https://wagbi.fun)

You type your coin idea in one sentence and Claude Sonnet 5.5 turns it into a full coin: a name and a ticker, a logo and an X banner drawn from scratch for the idea, a bio, and a page for the coin. Keep chatting to change any part; every version is kept. Then launch it from the same page.

## How it works

- `api/make.js` streams a coin kit. `api/_lib/engine.js` asks the model for the coin and for the art as SVG code, renders it to PNG with resvg, shows the render back to the model for an art-director pass, and keeps the better version.
- Chats and versions are stored per coin (`api/_lib/store.js`), with Google sign-in to keep them across devices (`api/auth.js`).
- `api/launch.js` and `api/_lib/launch/` run launches through a one-time deposit address: no wallet connection, leftover SOL goes back, a failed launch is refunded. pump.fun has a locked fee split (wagbi 15%, the rest is the creator's to split); on other launchpads the creator keeps all the creator fees.
- `api/transcribe.js` is voice input, `tool/meme.html` the meme generator, `api/coins.js` the public coins list.

## Notes

- The on-chain launch core is a private package (`printer-engine`) and is not included here.
- Configuration is by environment variables; nothing secret lives in this repo.
- Tests: `node --test test/`.
