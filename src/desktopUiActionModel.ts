export const DESKTOP_UI_MAX_SEQUENCE = 16;
export const DESKTOP_UI_MAX_COORDINATE = 65535;
export const DESKTOP_UI_MAX_TEXT_LENGTH = 256;

export const DESKTOP_UI_KEYS = [
  "ENTER",
  "ESCAPE",
  "TAB",
  "BACKSPACE",
  "ARROW_UP",
  "ARROW_DOWN",
  "ARROW_LEFT",
  "ARROW_RIGHT"
] as const;

export type DesktopUiKey = (typeof DESKTOP_UI_KEYS)[number];

export type DesktopUiAction =
  | {
      type: "POINTER_MOVE";
      x: number;
      y: number;
    }
  | {
      type: "POINTER_CLICK";
      button: "left" | "right";
    }
  | {
      type: "KEY_PRESS";
      key: DesktopUiKey;
    }
  | {
      type: "TYPE_TEXT";
      text: string;
    };

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();

  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("Desktop UI action contains unsupported or missing fields.");
  }
}

function assertCoordinate(value: unknown, field: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > DESKTOP_UI_MAX_COORDINATE
  ) {
    throw new Error(`Desktop UI ${field} coordinate is out of bounds.`);
  }

  return value as number;
}

function validateAction(input: unknown): DesktopUiAction {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Desktop UI action must be a plain object.");
  }

  const value = input as Record<string, unknown>;

  switch (value.type) {
    case "POINTER_MOVE": {
      assertExactKeys(value, ["type", "x", "y"]);
      return {
        type: "POINTER_MOVE",
        x: assertCoordinate(value.x, "x"),
        y: assertCoordinate(value.y, "y")
      };
    }

    case "POINTER_CLICK": {
      assertExactKeys(value, ["type", "button"]);
      if (value.button !== "left" && value.button !== "right") {
        throw new Error("Desktop UI pointer button must be left or right.");
      }
      return {
        type: "POINTER_CLICK",
        button: value.button
      };
    }

    case "KEY_PRESS": {
      assertExactKeys(value, ["type", "key"]);
      if (
        typeof value.key !== "string" ||
        !(DESKTOP_UI_KEYS as readonly string[]).includes(value.key)
      ) {
        throw new Error("Desktop UI key is not allowlisted.");
      }
      return {
        type: "KEY_PRESS",
        key: value.key as DesktopUiKey
      };
    }

    case "TYPE_TEXT": {
      assertExactKeys(value, ["type", "text"]);
      if (
        typeof value.text !== "string" ||
        value.text.length < 1 ||
        value.text.length > DESKTOP_UI_MAX_TEXT_LENGTH ||
        !/^[\x20-\x7E]+$/.test(value.text)
      ) {
        throw new Error("Desktop UI text must be bounded printable ASCII.");
      }
      return {
        type: "TYPE_TEXT",
        text: value.text
      };
    }

    default:
      throw new Error("Desktop UI action type is not allowlisted.");
  }
}

export function validateDesktopUiActionSequence(
  input: unknown
): DesktopUiAction[] {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > DESKTOP_UI_MAX_SEQUENCE
  ) {
    throw new Error("Desktop UI action sequence length must be 1..16.");
  }

  return input.map(validateAction);
}
