# Refinements after 1.0.3

Notes from Windows testing on a multi-display desk. Order is the order to build them. The normal editor is last and is its own task.

## 1. Fold does not unfold — bug

A folded memo (the title bar, “Fold memo” / “Unfold memo”) stays folded. Moving onto the bar to press Unfold does not open it.

Hovering a folded memo was recorded as an editing hold, the same hold used when the body of the bar is clicked so it stays open. The fold button, while that hold is set, only clears the hold and leaves `collapsed` true. Because the pointer has to enter the memo to reach the button, every attempt arms the hold again and Unfold never runs.

Hover may still peek the memo open. A click on the bar body, or focus in a text field, may still hold it open. The fold button itself always toggles the saved folded state.

## 2. A memo can sit off the screen

A resized or snapped memo can end with most of its window outside the work area. The edge that left the screen is then hard to find.

Two changes, both still to do:

1. When any edge of a memo window crosses a screen edge, paint a semi-transparent gradient on that memo, 30px wide, starting at the screen edge and fading into the window. It shows which way the window left.
2. With window snapping on, a memo snapped to the left or right screen edge must not hang past the bottom of that display. If its height would, shorten the height so the bottom of the window meets the bottom of the work area.

## 3. Pinned tab bar on more than one display

The tab bar is one strip. It is placed on a single monitor, along the top of that monitor’s work area, and it spans that work area’s width. The monitor is the one that contains the composer when the composer is visible, otherwise the monitor under the cursor, otherwise the primary monitor. Unpinning every memo, writing a new one, and pinning it again can move the strip, because that choice runs again.

That “follow the cursor when pinned mode turns on” behavior can stay the default. Settings should add:

- Which display the strip uses: the display under the cursor, a chosen display, or every display.
- Which edge it sits on: top, bottom, left, or right.

A strip on every display means one strip window per display. Left and right edges need a vertical strip; today the strip is only a short horizontal window.

## 4. Normal editor — separate task, last

The coder editor is usable. The normal editor is not, and it needs a rework rather than another small patch.

Seen so far:

- The caret is not on the character it is editing.
- Backspace does not remove or leave a code block.

Do this after the fold bug, the off-screen cues, and the tab-bar settings.
