$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$MaxInputChars = 8192
$MaxActions = 16
$MaxCoordinate = 65535
$MaxTextLength = 256

$source = @'
using System;
using System.Runtime.InteropServices;

public static class BoundedDesktopUiNative
{
    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)]
        public MOUSEINPUT mi;
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(
        uint nInputs,
        INPUT[] pInputs,
        int cbSize
    );
}
'@

Add-Type -TypeDefinition $source -Language CSharp

function Assert-ExactFields {
    param(
        [Parameter(Mandatory = $true)] $Value,
        [Parameter(Mandatory = $true)] [string[]] $Expected
    )

    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)

    if ($actual.Count -ne $wanted.Count) {
        throw "Invalid action fields."
    }

    for ($i = 0; $i -lt $wanted.Count; $i++) {
        if ($actual[$i] -cne $wanted[$i]) {
            throw "Invalid action fields."
        }
    }
}

function Invoke-NativeInput {
    param(
        [Parameter(Mandatory = $true)]
        [BoundedDesktopUiNative+INPUT] $InputValue
    )

    $items = New-Object 'BoundedDesktopUiNative+INPUT[]' 1
    $items[0] = $InputValue
    $size = [Runtime.InteropServices.Marshal]::SizeOf($InputValue)
    $sent = [BoundedDesktopUiNative]::SendInput(1, $items, $size)

    if ($sent -ne 1) {
        throw "SendInput failed."
    }
}

function New-MouseInput {
    param(
        [int] $X,
        [int] $Y,
        [uint32] $Flags
    )

    $inputValue = New-Object 'BoundedDesktopUiNative+INPUT'
    $inputValue.type = [BoundedDesktopUiNative]::INPUT_MOUSE
    $mouse = New-Object 'BoundedDesktopUiNative+MOUSEINPUT'
    $mouse.dx = $X
    $mouse.dy = $Y
    $mouse.mouseData = 0
    $mouse.dwFlags = $Flags
    $mouse.time = 0
    $mouse.dwExtraInfo = [UIntPtr]::Zero
    $inputValue.U.mi = $mouse
    return $inputValue
}

function New-KeyboardInput {
    param(
        [uint16] $VirtualKey,
        [uint16] $ScanCode,
        [uint32] $Flags
    )

    $inputValue = New-Object 'BoundedDesktopUiNative+INPUT'
    $inputValue.type = [BoundedDesktopUiNative]::INPUT_KEYBOARD
    $keyboard = New-Object 'BoundedDesktopUiNative+KEYBDINPUT'
    $keyboard.wVk = $VirtualKey
    $keyboard.wScan = $ScanCode
    $keyboard.dwFlags = $Flags
    $keyboard.time = 0
    $keyboard.dwExtraInfo = [UIntPtr]::Zero
    $inputValue.U.ki = $keyboard
    return $inputValue
}

function Invoke-KeyPair {
    param(
        [uint16] $VirtualKey,
        [uint16] $ScanCode,
        [uint32] $BaseFlags
    )

    $KEYEVENTF_KEYUP = [uint32]0x0002
    Invoke-NativeInput (New-KeyboardInput $VirtualKey $ScanCode $BaseFlags)
    Invoke-NativeInput (New-KeyboardInput $VirtualKey $ScanCode ($BaseFlags -bor $KEYEVENTF_KEYUP))
}

$executedCount = 0

try {
    $json = [Console]::In.ReadToEnd()

    if (
        [string]::IsNullOrEmpty($json) -or
        $json.Length -gt $MaxInputChars
    ) {
        throw "Invalid input."
    }

    $parsed = ConvertFrom-Json -InputObject $json
    $actions = @($parsed)

    if ($actions.Count -lt 1 -or $actions.Count -gt $MaxActions) {
        throw "Invalid action count."
    }

    $keyMap = @{
        "ENTER" = [uint16]0x0D
        "ESCAPE" = [uint16]0x1B
        "TAB" = [uint16]0x09
        "BACKSPACE" = [uint16]0x08
        "ARROW_UP" = [uint16]0x26
        "ARROW_DOWN" = [uint16]0x28
        "ARROW_LEFT" = [uint16]0x25
        "ARROW_RIGHT" = [uint16]0x27
    }

    foreach ($action in $actions) {
        if ($null -eq $action.type -or $action.type -isnot [string]) {
            throw "Invalid action type."
        }

        switch -CaseSensitive ($action.type) {
            "POINTER_MOVE" {
                Assert-ExactFields $action @("type", "x", "y")

                if (
                    $action.x -isnot [int] -and
                    $action.x -isnot [long]
                ) {
                    throw "Invalid x coordinate."
                }
                if (
                    $action.y -isnot [int] -and
                    $action.y -isnot [long]
                ) {
                    throw "Invalid y coordinate."
                }

                $x = [long]$action.x
                $y = [long]$action.y
                if (
                    $x -lt 0 -or $x -gt $MaxCoordinate -or
                    $y -lt 0 -or $y -gt $MaxCoordinate
                ) {
                    throw "Invalid pointer coordinate."
                }

                $MOUSEEVENTF_MOVE = [uint32]0x0001
                $MOUSEEVENTF_ABSOLUTE = [uint32]0x8000
                Invoke-NativeInput (
                    New-MouseInput ([int]$x) ([int]$y) (
                        $MOUSEEVENTF_MOVE -bor $MOUSEEVENTF_ABSOLUTE
                    )
                )
            }

            "POINTER_CLICK" {
                Assert-ExactFields $action @("type", "button")

                if ($action.button -cne "left" -and $action.button -cne "right") {
                    throw "Invalid pointer button."
                }

                if ($action.button -ceq "left") {
                    $down = [uint32]0x0002
                    $up = [uint32]0x0004
                } else {
                    $down = [uint32]0x0008
                    $up = [uint32]0x0010
                }

                Invoke-NativeInput (New-MouseInput 0 0 $down)
                Invoke-NativeInput (New-MouseInput 0 0 $up)
            }

            "KEY_PRESS" {
                Assert-ExactFields $action @("type", "key")

                if (
                    $action.key -isnot [string] -or
                    -not $keyMap.ContainsKey([string]$action.key)
                ) {
                    throw "Invalid key."
                }

                Invoke-KeyPair $keyMap[[string]$action.key] 0 0
            }

            "TYPE_TEXT" {
                Assert-ExactFields $action @("type", "text")

                if (
                    $action.text -isnot [string] -or
                    $action.text.Length -lt 1 -or
                    $action.text.Length -gt $MaxTextLength -or
                    $action.text -notmatch '^[\x20-\x7E]+$'
                ) {
                    throw "Invalid text."
                }

                $KEYEVENTF_UNICODE = [uint32]0x0004
                foreach ($char in $action.text.ToCharArray()) {
                    Invoke-KeyPair 0 ([uint16][char]$char) $KEYEVENTF_UNICODE
                }
            }

            default {
                throw "Unsupported action type."
            }
        }

        $executedCount += 1
    }

    [Console]::Out.WriteLine(
        '{"executed_count":' + $executedCount + ',"status":"EXECUTED"}'
    )
    exit 0
} catch {
    [Console]::Out.WriteLine(
        '{"executed_count":' + $executedCount + ',"status":"FAILED"}'
    )
    exit 2
}
