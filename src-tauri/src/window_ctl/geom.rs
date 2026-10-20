//! Pure window geometry: snap, grid, resize, and slide math.

#[allow(clippy::too_many_arguments)]
pub fn tray_card_origin(
    icon_x: i32,
    icon_y: i32,
    icon_w: i32,
    icon_h: i32,
    win_w: i32,
    win_h: i32,
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
    gap: i32,
) -> (i32, i32) {
    let icon_mid_x = icon_x.saturating_add(icon_w / 2);
    let icon_mid_y = icon_y.saturating_add(icon_h / 2);
    let area_mid_x = area_x.saturating_add(area_w / 2);
    let area_mid_y = area_y.saturating_add(area_h / 2);
    let x = if icon_mid_x > area_mid_x {
        icon_x.saturating_add(icon_w).saturating_sub(win_w)
    } else {
        icon_x
    };
    let y = if icon_mid_y < area_mid_y {
        icon_y.saturating_add(icon_h).saturating_add(gap)
    } else {
        icon_y.saturating_sub(gap).saturating_sub(win_h)
    };
    clamp_position(x, y, win_w, win_h, area_x, area_y, area_w, area_h)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn rects_overlap(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    ox: i32,
    oy: i32,
    ow: i32,
    oh: i32,
    pad: i32,
) -> bool {
    x < ox.saturating_add(ow).saturating_add(pad)
        && x.saturating_add(w).saturating_add(pad) > ox
        && y < oy.saturating_add(oh).saturating_add(pad)
        && y.saturating_add(h).saturating_add(pad) > oy
}

/// Move the window origin so a card edge that is against the work area sticks to it.
/// Other positions stay where the pointer put them.
#[allow(clippy::too_many_arguments)]
pub fn snap_screen_edges(
    origin_x: i32,
    origin_y: i32,
    card_w: i32,
    card_h: i32,
    pad_x: i32,
    pad_top: i32,
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
    catch: i32,
) -> (i32, i32) {
    let left = origin_x.saturating_add(pad_x);
    let top = origin_y.saturating_add(pad_top);
    let right = left.saturating_add(card_w);
    let bottom = top.saturating_add(card_h);
    let area_right = area_x.saturating_add(area_w);
    let area_bottom = area_y.saturating_add(area_h);
    let mut x = origin_x;
    let mut y = origin_y;
    let left_gap = (left - area_x).abs();
    let right_gap = (right - area_right).abs();
    if right_gap <= catch && right_gap <= left_gap {
        x = area_right.saturating_sub(card_w).saturating_sub(pad_x);
    } else if left_gap <= catch {
        x = area_x.saturating_sub(pad_x);
    }
    let top_gap = (top - area_y).abs();
    let bottom_gap = (bottom - area_bottom).abs();
    if top_gap <= catch && top_gap <= bottom_gap {
        y = area_y.saturating_sub(pad_top);
    } else if bottom_gap <= catch {
        y = area_bottom.saturating_sub(card_h).saturating_sub(pad_top);
    }
    (x, y)
}

pub(super) fn axis_gap(start: i32, end: i32, other_start: i32, other_end: i32) -> i32 {
    if end < other_start {
        other_start - end
    } else if other_end < start {
        start - other_end
    } else {
        0
    }
}

/// Nudge a card so a nearby memo's left, right, top, or bottom edge lines up.
/// A deep overlap is left alone so a memo can still be dropped onto another.
#[allow(clippy::too_many_arguments)]
pub fn snap_memo_edges(
    origin_x: i32,
    origin_y: i32,
    card_w: i32,
    card_h: i32,
    pad_x: i32,
    pad_top: i32,
    neighbors: &[(i32, i32, i32, i32)],
    catch: i32,
) -> (i32, i32) {
    let left = origin_x.saturating_add(pad_x);
    let top = origin_y.saturating_add(pad_top);
    let right = left.saturating_add(card_w);
    let bottom = top.saturating_add(card_h);
    let mut best_dx: Option<(i32, i32)> = None;
    let mut best_dy: Option<(i32, i32)> = None;
    for &(other_left, other_top, other_w, other_h) in neighbors {
        let other_right = other_left.saturating_add(other_w);
        let other_bottom = other_top.saturating_add(other_h);
        if axis_gap(left, right, other_left, other_right) > catch
            || axis_gap(top, bottom, other_top, other_bottom) > catch
        {
            continue;
        }
        let overlap_x = right.min(other_right).saturating_sub(left.max(other_left));
        let overlap_y = bottom.min(other_bottom).saturating_sub(top.max(other_top));
        if overlap_x > catch && overlap_y > catch {
            continue;
        }
        for edge in [right, left] {
            for other in [other_left, other_right] {
                let delta = other.saturating_sub(edge);
                let distance = delta.abs();
                if distance <= catch
                    && best_dx.is_none_or(|(best, best_delta)| {
                        distance < best || (distance == best && delta > best_delta)
                    })
                {
                    best_dx = Some((distance, delta));
                }
            }
        }
        for edge in [top, bottom] {
            for other in [other_top, other_bottom] {
                let delta = other.saturating_sub(edge);
                let distance = delta.abs();
                if distance <= catch && best_dy.is_none_or(|(best, _)| distance < best) {
                    best_dy = Some((distance, delta));
                }
            }
        }
    }
    (
        origin_x.saturating_add(best_dx.map(|(_, delta)| delta).unwrap_or(0)),
        origin_y.saturating_add(best_dy.map(|(_, delta)| delta).unwrap_or(0)),
    )
}

pub(super) struct OrganizeGrid {
    pub origin_x: i32,
    pub origin_y: i32,
    pub step_x: i32,
    pub step_y: i32,
    pub columns: usize,
    pub rows: usize,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn organize_grid(
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
    win_w: i32,
    win_h: i32,
    pad_x: i32,
    pad_top: i32,
    pad_bottom: i32,
    gap: i32,
) -> OrganizeGrid {
    let gap = gap.max(0);
    let card_w = (win_w - pad_x.saturating_mul(2)).max(1);
    let card_h = (win_h - pad_top - pad_bottom).max(1);
    let step_x = card_w + gap;
    let step_y = card_h + gap;
    let columns = ((area_w.saturating_sub(gap)) / step_x).max(1) as usize;
    let rows = ((area_h.saturating_sub(gap)) / step_y).max(1) as usize;
    OrganizeGrid {
        origin_x: area_x + gap - pad_x,
        origin_y: area_y + gap - pad_top,
        step_x,
        step_y,
        columns,
        rows,
    }
}

pub(super) fn visual_card(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    pad_x: i32,
    pad_top: i32,
    pad_bottom: i32,
) -> (i32, i32, i32, i32) {
    (
        x + pad_x,
        y + pad_top,
        (w - pad_x.saturating_mul(2)).max(1),
        (h - pad_top - pad_bottom).max(1),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn first_open_tile(
    occupied: &[(i32, i32, i32, i32)],
    origin_x: i32,
    origin_y: i32,
    step_x: i32,
    step_y: i32,
    pad_x: i32,
    pad_top: i32,
    card_w: i32,
    card_h: i32,
    columns: usize,
    rows: usize,
    gap: i32,
) -> (i32, i32) {
    let columns = columns.max(1);
    let rows = rows.max(1);
    for row in 0..rows {
        for col in 0..columns {
            let x = origin_x + col as i32 * step_x;
            let y = origin_y + row as i32 * step_y;
            let blocked = occupied.iter().any(|&(ox, oy, ow, oh)| {
                rects_overlap(x + pad_x, y + pad_top, card_w, card_h, ox, oy, ow, oh, gap)
            });
            if !blocked {
                return (x, y);
            }
        }
    }
    (origin_x, origin_y)
}

pub fn grid_slot(
    index: usize,
    columns: usize,
    origin_x: i32,
    origin_y: i32,
    cell_w: i32,
    cell_h: i32,
    gap: i32,
) -> (i32, i32) {
    let columns = columns.max(1);
    let col = (index % columns) as i32;
    let row = (index / columns) as i32;
    (
        origin_x + col * (cell_w + gap),
        origin_y + row * (cell_h + gap),
    )
}

pub(super) fn nudge_origin(x: i32, y: i32, taken: &[(i32, i32)], step: i32) -> (i32, i32) {
    let step = step.max(1);
    let mut x = x;
    let mut y = y;
    for _ in 0..32 {
        let blocked = taken
            .iter()
            .any(|(ox, oy)| (ox - x).abs() <= 8 && (oy - y).abs() <= 8);
        if !blocked {
            return (x, y);
        }
        x = x.saturating_add(step);
        y = y.saturating_add(step);
    }
    (x, y)
}

pub(super) fn closer_snap(current: i32, screen: i32, memo: i32) -> i32 {
    let screen_move = (screen - current).abs();
    let memo_move = (memo - current).abs();
    if screen_move == 0 {
        memo
    } else if memo_move == 0 || screen_move < memo_move {
        screen
    } else if memo_move < screen_move {
        memo
    } else {
        memo.max(screen)
    }
}

pub(super) fn closer_snap_x(current: i32, screen: i32, memo: i32) -> i32 {
    let screen_move = (screen - current).abs();
    let memo_move = (memo - current).abs();
    if screen_move == 0 {
        memo
    } else if memo_move == 0 {
        screen
    } else if memo > current && screen < current {
        // When caught between a screen edge on the left and a memo on the right,
        // prioritize snapping to the right.
        memo
    } else if (screen > current && memo < current) || screen_move < memo_move {
        screen
    } else if memo_move < screen_move {
        memo
    } else {
        screen.max(memo)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResizeEdge {
    East,
    South,
    West,
    SouthEast,
    SouthWest,
}

#[allow(clippy::too_many_arguments)]
pub fn resize_frame(
    start_x: i32,
    start_y: i32,
    start_w: i32,
    start_h: i32,
    dx: i32,
    dy: i32,
    min_w: i32,
    min_h: i32,
    edge: ResizeEdge,
) -> (i32, i32, i32, i32) {
    let width = match edge {
        ResizeEdge::East | ResizeEdge::SouthEast => start_w.saturating_add(dx).max(min_w),
        ResizeEdge::West | ResizeEdge::SouthWest => start_w.saturating_sub(dx).max(min_w),
        ResizeEdge::South => start_w,
    };
    let height = match edge {
        ResizeEdge::South | ResizeEdge::SouthEast | ResizeEdge::SouthWest => {
            start_h.saturating_add(dy).max(min_h)
        }
        ResizeEdge::East | ResizeEdge::West => start_h,
    };
    let x = match edge {
        ResizeEdge::West | ResizeEdge::SouthWest => {
            start_x.saturating_add(start_w.saturating_sub(width))
        }
        ResizeEdge::East | ResizeEdge::South | ResizeEdge::SouthEast => start_x,
    };
    (x, start_y, width, height)
}

pub(super) fn overlap_span(start: i32, length: i32, area_start: i32, area_end: i32) -> i32 {
    let end = start.saturating_add(length);
    area_end.min(end).saturating_sub(area_start.max(start))
}

/// Where to put a card that is even slightly, or almost entirely, off the left, right, or bottom.
/// `None` when the card is fully on screen or fully past that edge.
#[allow(clippy::too_many_arguments)]
pub fn slide_card_into_view(
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
) -> Option<(i32, i32)> {
    if width >= area_w || height >= area_h {
        return None;
    }
    let area_right = area_x.saturating_add(area_w);
    let area_bottom = area_y.saturating_add(area_h);
    let mut next_left = left;
    let mut next_top = top;
    let mut moved = false;
    if left < area_x && overlap_span(left, width, area_x, area_right) > 0 {
        next_left = area_x;
        moved = true;
    } else if left.saturating_add(width) > area_right && overlap_span(left, width, area_x, area_right) > 0 {
        next_left = area_right.saturating_sub(width);
        moved = true;
    }
    if top.saturating_add(height) > area_bottom && overlap_span(top, height, area_y, area_bottom) > 0 {
        next_top = area_bottom.saturating_sub(height);
        moved = true;
    }
    if moved { Some((next_left, next_top)) } else { None }
}

#[allow(clippy::too_many_arguments)]
pub fn clamp_position(
    cursor_x: i32,
    cursor_y: i32,
    window_w: i32,
    window_h: i32,
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
) -> (i32, i32) {
    let mut x = cursor_x;
    let mut y = cursor_y;
    let right = area_x.saturating_add(area_w);
    let bottom = area_y.saturating_add(area_h);
    if x.saturating_add(window_w) > right {
        x = right.saturating_sub(window_w);
    }
    if y.saturating_add(window_h) > bottom {
        y = bottom.saturating_sub(window_h);
    }
    if x < area_x {
        x = area_x;
    }
    if y < area_y {
        y = area_y;
    }
    (x, y)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_card_sits_under_a_top_right_icon() {
        let (x, y) = tray_card_origin(1800, 0, 40, 24, 400, 500, 0, 28, 1920, 1052, 8);
        assert_eq!(x, 1440);
        assert_eq!(y, 32);
    }

    #[test]
    fn tray_card_sits_above_a_bottom_right_icon() {
        let (x, y) = tray_card_origin(1800, 1040, 40, 40, 400, 500, 0, 0, 1920, 1000, 8);
        assert_eq!(x, 1440);
        assert_eq!(y, 500);
    }

    #[test]
    fn a_half_hidden_memo_slides_back_onto_the_screen() {
        let shown = slide_card_into_view(-150, 40, 300, 200, 0, 0, 1000, 800);
        assert_eq!(shown, Some((0, 40)));
        let right = slide_card_into_view(850, 40, 300, 200, 0, 0, 1000, 800);
        assert_eq!(right, Some((700, 40)));
        let bottom = slide_card_into_view(40, 700, 300, 200, 0, 0, 1000, 800);
        assert_eq!(bottom, Some((40, 600)));
        assert_eq!(slide_card_into_view(40, 40, 300, 200, 0, 0, 1000, 800), None);
        assert_eq!(slide_card_into_view(-8, 40, 300, 200, 0, 0, 1000, 800), Some((0, 40)));
        assert_eq!(slide_card_into_view(-294, 40, 300, 200, 0, 0, 1000, 800), Some((0, 40)));
        assert_eq!(slide_card_into_view(-400, 40, 300, 200, 0, 0, 1000, 800), None);
        assert_eq!(slide_card_into_view(-140, 0, 300, 800, 0, 0, 1000, 800), None);
        assert_eq!(slide_card_into_view(-140, -50, 300, 900, 0, 0, 1000, 800), None);
        assert_eq!(slide_card_into_view(-140, 40, 1000, 200, 0, 0, 1000, 800), None);
    }

    #[test]
    fn the_bottom_right_corner_changes_the_window_size() {
        assert_eq!(
            resize_frame(0, 0, 400, 500, 30, -20, 220, 140, ResizeEdge::SouthEast),
            (0, 0, 430, 480)
        );
        assert_eq!(
            resize_frame(0, 0, 400, 500, -300, -400, 220, 140, ResizeEdge::SouthEast),
            (0, 0, 220, 140)
        );
        assert_eq!(
            resize_frame(100, 50, 400, 500, -40, 30, 220, 140, ResizeEdge::SouthWest),
            (60, 50, 440, 530)
        );
        assert_eq!(
            resize_frame(100, 50, 400, 500, 300, 30, 220, 140, ResizeEdge::West),
            (280, 50, 220, 500)
        );
        assert_eq!(
            resize_frame(100, 50, 400, 500, 50, 40, 220, 140, ResizeEdge::East),
            (100, 50, 450, 500)
        );
        assert_eq!(
            resize_frame(100, 50, 400, 500, 50, 40, 220, 140, ResizeEdge::South),
            (100, 50, 400, 540)
        );
    }

    #[test]
    fn a_memo_lines_up_with_a_nearby_memo_edge() {
        let neighbors = [(110, 0, 100, 80)];
        let (x, y) = snap_memo_edges(0, 0, 100, 80, 0, 0, &neighbors, 22);
        assert_eq!((x, y), (10, 0));
        let (x, y) = snap_memo_edges(400, 0, 100, 80, 0, 0, &neighbors, 22);
        assert_eq!((x, y), (400, 0));
        let (x, y) = snap_memo_edges(50, 0, 100, 80, 0, 0, &neighbors, 22);
        assert_eq!((x, y), (50, 0));
        let (x, y) = snap_memo_edges(100, 8, 100, 80, 0, 0, &neighbors, 22);
        assert_eq!((x, y), (100, 8));
    }

    #[test]
    fn a_memo_moves_freely_until_it_meets_a_screen_edge() {
        let (x, y) = snap_screen_edges(200, 150, 300, 200, 0, 0, 0, 0, 1000, 800, 36);
        assert_eq!((x, y), (200, 150));
        let (x, y) = snap_screen_edges(10, 150, 300, 200, 0, 0, 0, 0, 1000, 800, 36);
        assert_eq!((x, y), (0, 150));
        let (x, y) = snap_screen_edges(680, 150, 300, 200, 0, 0, 0, 0, 1000, 800, 36);
        assert_eq!((x, y), (700, 150));
        let (x, y) = snap_screen_edges(200, 590, 300, 200, 0, 0, 0, 0, 1000, 800, 36);
        assert_eq!((x, y), (200, 600));
    }

    #[test]
    fn clamp_keeps_the_card_inside_the_work_area() {
        let (x, y) = clamp_position(1900, 1000, 380, 440, 0, 0, 1920, 1080);
        assert_eq!(x, 1920 - 380);
        assert_eq!(y, 1080 - 440);
        let (x, y) = clamp_position(12, 20, 380, 440, 0, 0, 1920, 1080);
        assert_eq!((x, y), (12, 20));
    }

    #[test]
    fn organized_notes_leave_a_few_pixels_between_cards() {
        let layout = organize_grid(0, 0, 1400, 900, 408, 476, 24, 24, 32, 4);
        assert_eq!(layout.step_x, 364);
        assert_eq!(layout.step_y, 424);
        let first = visual_card(layout.origin_x, layout.origin_y, 408, 476, 24, 24, 32);
        let second = visual_card(
            layout.origin_x + layout.step_x,
            layout.origin_y,
            408,
            476,
            24,
            24,
            32,
        );
        assert_eq!(first.0, 4);
        assert_eq!(second.0 - (first.0 + first.2), 4);
        let below = visual_card(
            layout.origin_x,
            layout.origin_y + layout.step_y,
            408,
            476,
            24,
            24,
            32,
        );
        assert_eq!(below.1 - (first.1 + first.3), 4);
        let last_col = (layout.columns - 1) as i32;
        let last = visual_card(
            layout.origin_x + last_col * layout.step_x,
            layout.origin_y,
            408,
            476,
            24,
            24,
            32,
        );
        assert!(last.0 + last.2 <= 1400 - 4);
    }

    #[test]
    fn grid_fills_rows_across_the_screen() {
        assert_eq!(grid_slot(0, 3, 10, 20, 100, 80, 8), (10, 20));
        assert_eq!(grid_slot(2, 3, 10, 20, 100, 80, 8), (10 + 2 * 108, 20));
        assert_eq!(grid_slot(3, 3, 10, 20, 100, 80, 8), (10, 20 + 88));
    }

    #[test]
    fn stacked_pins_step_apart() {
        assert_eq!(nudge_origin(10, 20, &[], 36), (10, 20));
        assert_eq!(nudge_origin(10, 20, &[(10, 20)], 36), (46, 56));
        assert_eq!(nudge_origin(10, 20, &[(10, 20), (46, 56)], 36), (82, 92));
        assert_eq!(nudge_origin(80, 20, &[(10, 20)], 36), (80, 20));
    }

    #[test]
    fn snapping_between_left_screen_edge_and_right_neighbor_prioritizes_right() {
        let layout = organize_grid(0, 0, 1400, 900, 408, 476, 24, 24, 32, 4);
        let first_x = layout.origin_x;
        let second = visual_card(
            layout.origin_x + layout.step_x,
            layout.origin_y,
            408,
            476,
            24,
            24,
            32,
        );
        let (screen_x, _) =
            snap_screen_edges(first_x, layout.origin_y, 360, 420, 24, 24, 0, 0, 1400, 900, 36);
        let (memo_x, _) =
            snap_memo_edges(first_x, layout.origin_y, 360, 420, 24, 24, &[second], 36);
        let chosen_x = closer_snap_x(first_x, screen_x, memo_x);
        assert_eq!(chosen_x, memo_x);
        assert!(chosen_x > first_x);
    }
}
