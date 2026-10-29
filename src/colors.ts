// Lane colours for the graph. Chosen to stay distinct from each other and
// readable on the dark background; a lane's colour index wraps around.
export const LANE_COLORS = [
  "#5aa9ff",
  "#f2a65a",
  "#7bd88f",
  "#e070c8",
  "#f25f5c",
  "#4fd1c5",
  "#c3a6ff",
  "#e5d36b",
  "#ff8fa3",
  "#8fb3c7",
];

export function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length];
}
