// Blindsight — Campaign stage table. Pure data: 50 fixed, numbered stages with
// escalating difficulty. Each stage pins a maze seed plus a set of difficulty
// multipliers that sim.js exposes as makeSim() opts — no new mechanics, just
// dialing existing levers (maze size, shard count, hunter speed, hearing radius,
// ping cooldown, dread ramp) further from stage 1 to stage 50.
//
// Note: HUNTER_SIGHT (215px) is a fixed constant in sim.js, not scaled per stage —
// a maze that's too physically small turns "forgiving" into "the hunter can see
// the whole room." So the maze only grows moderately across the arc; most of the
// early-game forgiveness comes from a slow, hard-of-hearing, long-cooldown hunter,
// and most of the late-game bite comes from a fast, sharp-eared, quick-recharging
// one plus a bigger maze to actually get lost (and hunted) in.
//
// Every seed here was chosen by a throwaway authoring script (tools/, not shipped)
// that brute-forced seed variants per difficulty preset and kept only ones where,
// against the REAL makeSim()/stepSim():
//   1. spawn, every shard, the exit, and the hunter are flood-fill reachable;
//   2. the hunter doesn't get stuck patrolling in place (a maze/AI corner case
//      the search rejects outright rather than shipping);
//   3. a scripted objective-seeking bot (BFS pathing to the nearest shard, then
//      the exit; flees toward LOS-breaking cover when the hunter spots it)
//      actually completes the stage within a two-minute frame budget;
//   4. on stages 26-50, a deliberately loud/careless bot (constant wide pings,
//      never sneaks) gets caught — proving stealth is required, not decorative,
//      once the campaign gets hard.
// See registerSelftest('blindsight', ...) in game.js for the in-repo re-check of
// (1) and stage-table shape at load time.

export const STAGES = [
  { n: 1, seed: "BSTAGE01_1", cols: 8, rows: 6, shardCount: 2, hunterSpeedMul: 0.5, hearMul: 0.4, pingCoolMul: 0.9, dreadMul: 0.75 },
  { n: 2, seed: "BSTAGE02_0", cols: 8, rows: 6, shardCount: 2, hunterSpeedMul: 0.514, hearMul: 0.413, pingCoolMul: 0.909, dreadMul: 0.76 },
  { n: 3, seed: "BSTAGE03_0", cols: 8, rows: 6, shardCount: 2, hunterSpeedMul: 0.528, hearMul: 0.427, pingCoolMul: 0.918, dreadMul: 0.77 },
  { n: 4, seed: "BSTAGE04_0", cols: 9, rows: 6, shardCount: 2, hunterSpeedMul: 0.542, hearMul: 0.44, pingCoolMul: 0.928, dreadMul: 0.781 },
  { n: 5, seed: "BSTAGE05_0", cols: 9, rows: 7, shardCount: 2, hunterSpeedMul: 0.556, hearMul: 0.453, pingCoolMul: 0.937, dreadMul: 0.791 },
  { n: 6, seed: "BSTAGE06_1", cols: 9, rows: 7, shardCount: 2, hunterSpeedMul: 0.569, hearMul: 0.466, pingCoolMul: 0.946, dreadMul: 0.801 },
  { n: 7, seed: "BSTAGE07_0", cols: 9, rows: 7, shardCount: 2, hunterSpeedMul: 0.583, hearMul: 0.48, pingCoolMul: 0.955, dreadMul: 0.811 },
  { n: 8, seed: "BSTAGE08_0", cols: 9, rows: 7, shardCount: 3, hunterSpeedMul: 0.597, hearMul: 0.493, pingCoolMul: 0.964, dreadMul: 0.821 },
  { n: 9, seed: "BSTAGE09_2", cols: 10, rows: 7, shardCount: 3, hunterSpeedMul: 0.611, hearMul: 0.506, pingCoolMul: 0.973, dreadMul: 0.832 },
  { n: 10, seed: "BSTAGE10_1", cols: 10, rows: 7, shardCount: 3, hunterSpeedMul: 0.625, hearMul: 0.519, pingCoolMul: 0.983, dreadMul: 0.842 },
  { n: 11, seed: "BSTAGE11_0", cols: 10, rows: 7, shardCount: 3, hunterSpeedMul: 0.639, hearMul: 0.533, pingCoolMul: 0.992, dreadMul: 0.852 },
  { n: 12, seed: "BSTAGE12_0", cols: 10, rows: 8, shardCount: 3, hunterSpeedMul: 0.653, hearMul: 0.546, pingCoolMul: 1.001, dreadMul: 0.862 },
  { n: 13, seed: "BSTAGE13_1", cols: 10, rows: 8, shardCount: 3, hunterSpeedMul: 0.667, hearMul: 0.559, pingCoolMul: 1.01, dreadMul: 0.872 },
  { n: 14, seed: "BSTAGE14_2", cols: 11, rows: 8, shardCount: 3, hunterSpeedMul: 0.68, hearMul: 0.572, pingCoolMul: 1.019, dreadMul: 0.883 },
  { n: 15, seed: "BSTAGE15_0", cols: 11, rows: 8, shardCount: 3, hunterSpeedMul: 0.694, hearMul: 0.586, pingCoolMul: 1.029, dreadMul: 0.893 },
  { n: 16, seed: "BSTAGE16_2", cols: 11, rows: 8, shardCount: 3, hunterSpeedMul: 0.708, hearMul: 0.599, pingCoolMul: 1.038, dreadMul: 0.903 },
  { n: 17, seed: "BSTAGE17_1", cols: 11, rows: 8, shardCount: 3, hunterSpeedMul: 0.722, hearMul: 0.612, pingCoolMul: 1.047, dreadMul: 0.913 },
  { n: 18, seed: "BSTAGE18_1", cols: 11, rows: 8, shardCount: 3, hunterSpeedMul: 0.736, hearMul: 0.626, pingCoolMul: 1.056, dreadMul: 0.923 },
  { n: 19, seed: "BSTAGE19_0", cols: 12, rows: 9, shardCount: 3, hunterSpeedMul: 0.75, hearMul: 0.639, pingCoolMul: 1.065, dreadMul: 0.934 },
  { n: 20, seed: "BSTAGE20_5", cols: 12, rows: 9, shardCount: 4, hunterSpeedMul: 0.764, hearMul: 0.652, pingCoolMul: 1.074, dreadMul: 0.944 },
  { n: 21, seed: "BSTAGE21_0", cols: 12, rows: 9, shardCount: 4, hunterSpeedMul: 0.778, hearMul: 0.665, pingCoolMul: 1.084, dreadMul: 0.954 },
  { n: 22, seed: "BSTAGE22_0", cols: 12, rows: 9, shardCount: 4, hunterSpeedMul: 0.791, hearMul: 0.679, pingCoolMul: 1.093, dreadMul: 0.964 },
  { n: 23, seed: "BSTAGE23_1", cols: 12, rows: 9, shardCount: 4, hunterSpeedMul: 0.805, hearMul: 0.692, pingCoolMul: 1.102, dreadMul: 0.974 },
  { n: 24, seed: "BSTAGE24_0", cols: 13, rows: 9, shardCount: 4, hunterSpeedMul: 0.819, hearMul: 0.705, pingCoolMul: 1.111, dreadMul: 0.985 },
  { n: 25, seed: "BSTAGE25_3", cols: 13, rows: 9, shardCount: 4, hunterSpeedMul: 0.833, hearMul: 0.718, pingCoolMul: 1.12, dreadMul: 0.995 },
  { n: 26, seed: "BSTAGE26_2", cols: 13, rows: 10, shardCount: 4, hunterSpeedMul: 0.847, hearMul: 0.732, pingCoolMul: 1.13, dreadMul: 1.005 },
  { n: 27, seed: "BSTAGE27_2", cols: 13, rows: 10, shardCount: 4, hunterSpeedMul: 0.861, hearMul: 0.745, pingCoolMul: 1.139, dreadMul: 1.015 },
  { n: 28, seed: "BSTAGE28_0", cols: 14, rows: 10, shardCount: 4, hunterSpeedMul: 0.875, hearMul: 0.758, pingCoolMul: 1.148, dreadMul: 1.026 },
  { n: 29, seed: "BSTAGE29_0", cols: 14, rows: 10, shardCount: 4, hunterSpeedMul: 0.889, hearMul: 0.771, pingCoolMul: 1.157, dreadMul: 1.036 },
  { n: 30, seed: "BSTAGE30_0", cols: 14, rows: 10, shardCount: 4, hunterSpeedMul: 0.902, hearMul: 0.785, pingCoolMul: 1.166, dreadMul: 1.046 },
  { n: 31, seed: "BSTAGE31_6", cols: 14, rows: 10, shardCount: 4, hunterSpeedMul: 0.916, hearMul: 0.798, pingCoolMul: 1.176, dreadMul: 1.056 },
  { n: 32, seed: "BSTAGE32_5", cols: 14, rows: 10, shardCount: 5, hunterSpeedMul: 0.93, hearMul: 0.811, pingCoolMul: 1.185, dreadMul: 1.066 },
  { n: 33, seed: "BSTAGE33_3", cols: 15, rows: 11, shardCount: 5, hunterSpeedMul: 0.944, hearMul: 0.824, pingCoolMul: 1.194, dreadMul: 1.077 },
  { n: 34, seed: "BSTAGE34_1", cols: 15, rows: 11, shardCount: 5, hunterSpeedMul: 0.958, hearMul: 0.838, pingCoolMul: 1.203, dreadMul: 1.087 },
  { n: 35, seed: "BSTAGE35_0", cols: 15, rows: 11, shardCount: 5, hunterSpeedMul: 0.972, hearMul: 0.851, pingCoolMul: 1.212, dreadMul: 1.097 },
  { n: 36, seed: "BSTAGE36_0", cols: 15, rows: 11, shardCount: 5, hunterSpeedMul: 0.986, hearMul: 0.864, pingCoolMul: 1.221, dreadMul: 1.107 },
  { n: 37, seed: "BSTAGE37_2", cols: 15, rows: 11, shardCount: 5, hunterSpeedMul: 1, hearMul: 0.878, pingCoolMul: 1.231, dreadMul: 1.117 },
  { n: 38, seed: "BSTAGE38_1", cols: 16, rows: 11, shardCount: 5, hunterSpeedMul: 1.013, hearMul: 0.891, pingCoolMul: 1.24, dreadMul: 1.128 },
  { n: 39, seed: "BSTAGE39_13", cols: 16, rows: 11, shardCount: 5, hunterSpeedMul: 1.027, hearMul: 0.904, pingCoolMul: 1.249, dreadMul: 1.138 },
  { n: 40, seed: "BSTAGE40_1", cols: 16, rows: 12, shardCount: 5, hunterSpeedMul: 1.041, hearMul: 0.917, pingCoolMul: 1.258, dreadMul: 1.148 },
  { n: 41, seed: "BSTAGE41_4", cols: 16, rows: 12, shardCount: 5, hunterSpeedMul: 1.055, hearMul: 0.931, pingCoolMul: 1.267, dreadMul: 1.158 },
  { n: 42, seed: "BSTAGE42_0", cols: 16, rows: 12, shardCount: 5, hunterSpeedMul: 1.069, hearMul: 0.944, pingCoolMul: 1.277, dreadMul: 1.168 },
  { n: 43, seed: "BSTAGE43_0", cols: 17, rows: 12, shardCount: 5, hunterSpeedMul: 1.083, hearMul: 0.957, pingCoolMul: 1.286, dreadMul: 1.179 },
  { n: 44, seed: "BSTAGE44_0", cols: 17, rows: 12, shardCount: 6, hunterSpeedMul: 1.097, hearMul: 0.97, pingCoolMul: 1.295, dreadMul: 1.189 },
  { n: 45, seed: "BSTAGE45_19", cols: 17, rows: 12, shardCount: 6, hunterSpeedMul: 1.111, hearMul: 0.984, pingCoolMul: 1.304, dreadMul: 1.199 },
  { n: 46, seed: "BSTAGE46_14", cols: 17, rows: 12, shardCount: 6, hunterSpeedMul: 1.124, hearMul: 0.997, pingCoolMul: 1.313, dreadMul: 1.209 },
  { n: 47, seed: "BSTAGE47_17", cols: 17, rows: 13, shardCount: 6, hunterSpeedMul: 1.138, hearMul: 1.01, pingCoolMul: 1.322, dreadMul: 1.219 },
  { n: 48, seed: "BSTAGE48_31", cols: 18, rows: 13, shardCount: 6, hunterSpeedMul: 1.152, hearMul: 1.023, pingCoolMul: 1.332, dreadMul: 1.23 },
  { n: 49, seed: "BSTAGE49_1", cols: 18, rows: 13, shardCount: 6, hunterSpeedMul: 1.166, hearMul: 1.037, pingCoolMul: 1.341, dreadMul: 1.24 },
  { n: 50, seed: "BSTAGE50_38", cols: 18, rows: 13, shardCount: 6, hunterSpeedMul: 1.18, hearMul: 1.05, pingCoolMul: 1.35, dreadMul: 1.25 },
];
