# mill 1.7.0-beta.9 — "Continue to app" on the Connected screen

> **Status: implemented in 1.7.0-beta.9.** One-function change.

The built-in **Connected** screen had only ghost actions (Take control / Use a
different key / Disconnect & Switch Account) and no primary way to dismiss — the
only exits were the ✕ and the backdrop. A first-time user had no obvious "I'm
done, take me to the app" action.

**Change.** `renderConnectedScreen` gains a primary **Continue to app** button as
the first action (above the ghost buttons); it calls `opts.onContinue`, wired at
the call site to `this.close()` (which fires the host's `onClose`; `onConnected`
has already fired). Label overridable via `opts.continueLabel`. ✕ and
backdrop-click still work. Applies to every method, not just pomegranate.

Order on screen: **Continue to app** (primary) → Take control / Use a different
key (ghost, when applicable) → Disconnect & Switch Account (ghost).

Verified: Connected screen shows the primary button first; clicking it fires
`onClose` and closes the modal; the ghost actions still work below it.
