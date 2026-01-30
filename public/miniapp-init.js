import { sdk } from "/vendor/miniapp-sdk.js";

(async () => {
  try {
    await sdk.actions.ready();
  } catch (_) {
  }
})();
