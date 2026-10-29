//! Lane layout for the commit graph.
//!
//! Input is a list of commits in topological order (children before
//! parents). Output is, per row, the lane the commit sits on plus the line
//! segments to draw in the upper and lower half of that row. Each row is
//! self-contained, so the frontend can draw any visible window of rows
//! without looking at its neighbours.
//!
//! Upper half: a segment goes from lane `from` at the top edge to lane `to`
//! at the row's vertical centre. Lower half: from lane `from` at the centre
//! to lane `to` at the bottom edge. A vertical pass-through line therefore
//! has `from == to` in both halves.

use serde::{Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Seg {
    pub from: u16,
    pub to: u16,
    pub color: u16,
}

// Sent as `[from, to, color]`: a graph has tens of thousands of rows with
// several segments each, and field names would triple the payload.
impl Serialize for Seg {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        (self.from, self.to, self.color).serialize(s)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowLayout {
    pub lane: u16,
    pub color: u16,
    pub up: Vec<Seg>,
    pub down: Vec<Seg>,
}

pub struct Layout {
    pub rows: Vec<RowLayout>,
    pub max_lanes: usize,
}

/// A lane is waiting for `id` to appear further down; `color` is fixed for
/// the lifetime of the lane so a branch keeps one colour top to bottom.
struct Slot<K> {
    id: K,
    color: u16,
}

fn alloc<K>(lanes: &mut Vec<Option<Slot<K>>>) -> usize {
    match lanes.iter().position(Option::is_none) {
        Some(i) => i,
        None => {
            lanes.push(None);
            lanes.len() - 1
        }
    }
}

fn find<K: PartialEq>(lanes: &[Option<Slot<K>>], id: &K) -> Option<usize> {
    lanes
        .iter()
        .position(|s| matches!(s, Some(slot) if &slot.id == id))
}

pub fn layout<K: PartialEq + Clone>(nodes: &[(K, Vec<K>)]) -> Layout {
    let mut lanes: Vec<Option<Slot<K>>> = Vec::new();
    let mut next_color: u16 = 0;
    let mut new_color = || {
        let c = next_color;
        next_color = next_color.wrapping_add(1);
        c
    };
    let mut rows = Vec::with_capacity(nodes.len());
    let mut max_lanes = 0;

    for (id, parents) in nodes {
        // Where does this commit sit? The first lane that was waiting for
        // it, or a fresh lane if nothing points here (a branch tip).
        let (lane, color) = match find(&lanes, id) {
            Some(i) => (i, lanes[i].as_ref().unwrap().color),
            None => {
                let i = alloc(&mut lanes);
                (i, new_color())
            }
        };

        let up: Vec<Seg> = lanes
            .iter()
            .enumerate()
            .filter_map(|(j, s)| {
                s.as_ref().map(|slot| Seg {
                    from: j as u16,
                    to: if &slot.id == id { lane as u16 } else { j as u16 },
                    color: slot.color,
                })
            })
            .collect();

        // Every lane that was waiting for this commit ends here.
        for s in lanes.iter_mut() {
            if matches!(s, Some(slot) if &slot.id == id) {
                *s = None;
            }
        }

        // Lines leaving the commit node towards its parents: (lane, colour).
        let mut from_node: Vec<(usize, u16)> = Vec::new();
        // Lanes that end in this row by bending into the commit's lane.
        let mut folded: Vec<(usize, u16)> = Vec::new();
        for (n, p) in parents.iter().enumerate() {
            if let Some(j) = find(&lanes, p).filter(|&j| n == 0 && j > lane) {
                // The first parent is awaited further right (typically a
                // side branch forked from it). Keep the first-parent chain
                // on the left lane and fold the right lane into it, so a
                // branch's own history doesn't drift sideways.
                let other = lanes[j].take().unwrap();
                folded.push((j, other.color));
                lanes[lane] = Some(Slot { id: p.clone(), color });
                from_node.push((lane, color));
            } else if let Some(j) = find(&lanes, p) {
                // Parent is already expected on another lane: join it. The
                // first-parent line belongs to this branch, so it keeps our
                // colour; a merged-in parent keeps its own lane's colour.
                let c = if n == 0 { color } else { lanes[j].as_ref().unwrap().color };
                from_node.push((j, c));
            } else if n == 0 {
                lanes[lane] = Some(Slot { id: p.clone(), color });
                from_node.push((lane, color));
            } else {
                let k = alloc(&mut lanes);
                let c = new_color();
                lanes[k] = Some(Slot { id: p.clone(), color: c });
                from_node.push((k, c));
            }
        }

        let mut down: Vec<Seg> = folded
            .iter()
            .map(|&(j, c)| Seg { from: j as u16, to: lane as u16, color: c })
            .collect();
        for (j, s) in lanes.iter().enumerate() {
            let Some(slot) = s else { continue };
            match from_node.iter().find(|(k, _)| *k == j) {
                // A lane that passed through this row (one that wasn't
                // waiting for this commit) also continues straight down,
                // in addition to the line from the node.
                Some(&(_, c)) => {
                    if j != lane && up.iter().any(|u| u.from as usize == j && u.to as usize == j) {
                        down.push(Seg { from: j as u16, to: j as u16, color: slot.color });
                    }
                    down.push(Seg { from: lane as u16, to: j as u16, color: c });
                }
                None => down.push(Seg { from: j as u16, to: j as u16, color: slot.color }),
            }
        }

        max_lanes = max_lanes.max(lanes.len());
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }

        rows.push(RowLayout { lane: lane as u16, color, up, down });
    }

    Layout { rows, max_lanes }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(id: &'static str, parents: &[&'static str]) -> (&'static str, Vec<&'static str>) {
        (id, parents.to_vec())
    }

    fn seg(from: u16, to: u16, color: u16) -> Seg {
        Seg { from, to, color }
    }

    #[test]
    fn linear_history_stays_on_one_lane() {
        let l = layout(&[n("c", &["b"]), n("b", &["a"]), n("a", &[])]);
        assert_eq!(l.max_lanes, 1);
        assert!(l.rows.iter().all(|r| r.lane == 0 && r.color == 0));
        assert!(l.rows[0].up.is_empty());
        assert_eq!(l.rows[0].down, vec![seg(0, 0, 0)]);
        assert_eq!(l.rows[1].up, vec![seg(0, 0, 0)]);
        assert!(l.rows[2].down.is_empty());
    }

    #[test]
    fn branch_and_merge() {
        //   m        merge of b2 into a2
        //   |\
        //   a2 b2
        //   |  |
        //   |  b1
        //   |/
        //   a1
        let l = layout(&[
            n("m", &["a2", "b2"]),
            n("a2", &["a1"]),
            n("b2", &["b1"]),
            n("b1", &["a1"]),
            n("a1", &[]),
        ]);
        assert_eq!(l.max_lanes, 2);
        let lanes: Vec<u16> = l.rows.iter().map(|r| r.lane).collect();
        assert_eq!(lanes, vec![0, 0, 1, 1, 0]);

        // The merge node opens a second lane with a new colour.
        assert_eq!(l.rows[0].down, vec![seg(0, 0, 0), seg(0, 1, 1)]);
        // a2 continues on its own lane: exactly one line per lane.
        assert_eq!(l.rows[1].down, vec![seg(0, 0, 0), seg(1, 1, 1)]);
        // b1's first parent a1 is already expected on lane 0: it joins it.
        assert_eq!(l.rows[3].down, vec![seg(0, 0, 0), seg(1, 0, 1)]);
        // a1 receives only the lane-0 line; the join happened in b1's row.
        assert_eq!(l.rows[4].up, vec![seg(0, 0, 0)]);
    }

    #[test]
    fn two_tips_converge_on_shared_parent() {
        // Two branch heads with the same parent: second tip gets its own
        // lane and both lines meet at the parent.
        let l = layout(&[n("x", &["base"]), n("y", &["base"]), n("base", &[])]);
        assert_eq!(l.rows[0].lane, 0);
        assert_eq!(l.rows[1].lane, 1);
        assert_eq!(l.rows[1].down, vec![seg(0, 0, 0), seg(1, 0, 1)]);
        assert_eq!(l.rows[2].lane, 0);
    }

    #[test]
    fn first_parent_chain_stays_on_the_left_lane() {
        // main: A -> B -> C, side branch E forked from C and listed
        // between A and B (newer than B).
        let l = layout(&[
            n("A", &["B"]),
            n("E", &["C"]),
            n("B", &["C"]),
            n("C", &[]),
        ]);
        let lanes: Vec<u16> = l.rows.iter().map(|r| r.lane).collect();
        assert_eq!(lanes, vec![0, 1, 0, 0]);
        // E's lane bends into lane 0 below B instead of B moving right.
        assert_eq!(l.rows[2].down, vec![seg(1, 0, 1), seg(0, 0, 0)]);
        assert!(l.rows.iter().filter(|r| r.lane == 0).all(|r| r.color == 0));
        assert_eq!(l.rows[3].up, vec![seg(0, 0, 0)]);
    }

    #[test]
    fn freed_lanes_are_reused_and_trimmed() {
        let l = layout(&[
            n("m", &["a", "b"]),
            n("b", &["root"]),
            n("a", &["root"]),
            n("t", &["x"]),
            n("x", &["root"]),
            n("root", &[]),
        ]);
        // `a` takes root back onto lane 0 and folds b's lane 1 into it;
        // the later tip `t` must reuse lane 1 instead of opening lane 2.
        assert_eq!(l.rows[2].down, vec![seg(1, 0, 1), seg(0, 0, 0)]);
        assert_eq!(l.rows[3].lane, 1);
        assert_eq!(l.max_lanes, 2);
    }

    #[test]
    fn missing_parent_keeps_lane_open_to_the_bottom() {
        // History truncated by a limit: the parent never shows up.
        let l = layout(&[n("c", &["b"]), n("b", &["not-loaded"])]);
        assert_eq!(l.rows[1].down, vec![seg(0, 0, 0)]);
    }
}
