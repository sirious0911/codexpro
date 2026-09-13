import assert from "node:assert/strict";
import {
  DESKTOP_UI_KEYS,
  DESKTOP_UI_MAX_COORDINATE,
  DESKTOP_UI_MAX_SEQUENCE,
  DESKTOP_UI_MAX_TEXT_LENGTH,
  validateDesktopUiActionSequence
} from "../src/desktopUiActionModel.ts";
import {
  executeDesktopUiActions
} from "../src/desktopUiExecution.ts";
import {
  runDesktopUiOperator
} from "../src/desktopUiOperator.ts";

assert.deepEqual(DESKTOP_UI_KEYS, [
  "ENTER",
  "ESCAPE",
  "TAB",
  "BACKSPACE",
  "ARROW_UP",
  "ARROW_DOWN",
  "ARROW_LEFT",
  "ARROW_RIGHT"
]);

const sample = [
  {
    type: "POINTER_MOVE",
    x: 100,
    y: 200
  },
  {
    type: "POINTER_CLICK",
    button: "left"
  },
  {
    type: "KEY_PRESS",
    key: "ENTER"
  },
  {
    type: "TYPE_TEXT",
    text: "Hello, desktop!"
  }
];

assert.deepEqual(validateDesktopUiActionSequence(sample), sample);

assert.deepEqual(runDesktopUiOperator({ actions: sample }), {
  action_count: 4,
  actions: sample,
  status: "DRY_RUN"
});

assert.deepEqual(
  runDesktopUiOperator({
    actions: sample,
    dry_run: true
  }),
  {
    action_count: 4,
    actions: sample,
    status: "DRY_RUN"
  }
);

assert.throws(
  () =>
    runDesktopUiOperator({
      actions: sample,
      dry_run: false
    }),
  /dry-run only/
);

const edgeSequence = [
  {
    type: "POINTER_MOVE",
    x: 0,
    y: DESKTOP_UI_MAX_COORDINATE
  },
  {
    type: "POINTER_CLICK",
    button: "right"
  },
  {
    type: "TYPE_TEXT",
    text: "x".repeat(DESKTOP_UI_MAX_TEXT_LENGTH)
  }
];

assert.deepEqual(validateDesktopUiActionSequence(edgeSequence), edgeSequence);

for (const key of DESKTOP_UI_KEYS) {
  assert.deepEqual(
    validateDesktopUiActionSequence([
      {
        type: "KEY_PRESS",
        key
      }
    ]),
    [
      {
        type: "KEY_PRESS",
        key
      }
    ]
  );
}

assert.throws(() => validateDesktopUiActionSequence([]), /1..16/);
assert.throws(
  () =>
    validateDesktopUiActionSequence(
      Array.from({ length: DESKTOP_UI_MAX_SEQUENCE + 1 }, () => ({
        type: "KEY_PRESS",
        key: "TAB"
      }))
    ),
  /1..16/
);

for (const invalid of [
  [{ type: "POINTER_MOVE", x: -1, y: 0 }],
  [{ type: "POINTER_MOVE", x: 0, y: DESKTOP_UI_MAX_COORDINATE + 1 }],
  [{ type: "POINTER_MOVE", x: 1.5, y: 2 }],
  [{ type: "POINTER_MOVE", x: 1, y: 2, extra: true }],
  [{ type: "POINTER_CLICK", button: "middle" }],
  [{ type: "POINTER_CLICK", button: "left", x: 1 }],
  [{ type: "KEY_PRESS", key: "A" }],
  [{ type: "KEY_PRESS", key: "ENTER", modifier: "CTRL" }],
  [{ type: "TYPE_TEXT", text: "" }],
  [{ type: "TYPE_TEXT", text: "line\nbreak" }],
  [{ type: "TYPE_TEXT", text: "tab\ttext" }],
  [{ type: "TYPE_TEXT", text: "\u001b" }],
  [{ type: "TYPE_TEXT", text: "x".repeat(DESKTOP_UI_MAX_TEXT_LENGTH + 1) }],
  [{ type: "UNKNOWN" }]
]) {
  assert.throws(() => validateDesktopUiActionSequence(invalid));
}

const normalized = validateDesktopUiActionSequence(sample);
const recorded = [];
assert.deepEqual(
  executeDesktopUiActions(normalized, {
    perform: (action) => {
      recorded.push(action);
    }
  }),
  {
    executed_count: 4,
    status: "EXECUTED"
  }
);
assert.deepEqual(recorded, sample);

assert.throws(
  () => executeDesktopUiActions(normalized),
  /injected runtime/
);

{
  const seen = [];
  assert.throws(
    () =>
      executeDesktopUiActions(normalized, {
        perform: (action) => {
          seen.push(action.type);
          if (seen.length === 2) {
            throw new Error("synthetic failure");
          }
        }
      }),
    /synthetic failure/
  );
  assert.deepEqual(seen, ["POINTER_MOVE", "POINTER_CLICK"]);
}

console.log("desktop-ui-operator-smoke: PASS");
