/**
 * The tiles of the two real connected sets that drew the island above (ocean
 * to sand, then sand to grass), by the terrain on each corner. Three terrains:
 * 0 ocean, 1 sand, 2 grass. Each key is "NW,NE,SW,SE". There is no tile with
 * ocean and grass on the same tile, because no set joins them.
 *
 * Written from `pixelkiln export --style coast --format generic --merge-connected`
 * on website/art/pixellab-0.4.130, whose `corners` are exactly these keys.
 */
export const COAST_TERRAINS = ["ocean", "sand", "grass"] as const;

export const COAST_TILES: Record<string, string> = {
  "0,0,0,0": "/showcase/tilesets/ocean-sand-tile-06-wang-0.png",
  "0,0,0,1": "/showcase/tilesets/ocean-sand-tile-07-wang-1.png",
  "0,0,1,0": "/showcase/tilesets/ocean-sand-tile-10-wang-2.png",
  "0,0,1,1": "/showcase/tilesets/ocean-sand-tile-09-wang-3.png",
  "0,1,0,0": "/showcase/tilesets/ocean-sand-tile-02-wang-4.png",
  "0,1,0,1": "/showcase/tilesets/ocean-sand-tile-11-wang-5.png",
  "0,1,1,0": "/showcase/tilesets/ocean-sand-tile-04-wang-6.png",
  "0,1,1,1": "/showcase/tilesets/ocean-sand-tile-15-wang-7.png",
  "1,0,0,0": "/showcase/tilesets/ocean-sand-tile-05-wang-8.png",
  "1,0,0,1": "/showcase/tilesets/ocean-sand-tile-14-wang-9.png",
  "1,0,1,0": "/showcase/tilesets/ocean-sand-tile-01-wang-10.png",
  "1,0,1,1": "/showcase/tilesets/ocean-sand-tile-08-wang-11.png",
  "1,1,0,0": "/showcase/tilesets/ocean-sand-tile-03-wang-12.png",
  "1,1,0,1": "/showcase/tilesets/ocean-sand-tile-00-wang-13.png",
  "1,1,1,0": "/showcase/tilesets/ocean-sand-tile-13-wang-14.png",
  "1,1,1,1": "/showcase/tilesets/sand-grass-tile-06-wang-0.png",
  "1,1,1,2": "/showcase/tilesets/sand-grass-tile-07-wang-1.png",
  "1,1,2,1": "/showcase/tilesets/sand-grass-tile-10-wang-2.png",
  "1,1,2,2": "/showcase/tilesets/sand-grass-tile-09-wang-3.png",
  "1,2,1,1": "/showcase/tilesets/sand-grass-tile-02-wang-4.png",
  "1,2,1,2": "/showcase/tilesets/sand-grass-tile-11-wang-5.png",
  "1,2,2,1": "/showcase/tilesets/sand-grass-tile-04-wang-6.png",
  "1,2,2,2": "/showcase/tilesets/sand-grass-tile-15-wang-7.png",
  "2,1,1,1": "/showcase/tilesets/sand-grass-tile-05-wang-8.png",
  "2,1,1,2": "/showcase/tilesets/sand-grass-tile-14-wang-9.png",
  "2,1,2,1": "/showcase/tilesets/sand-grass-tile-01-wang-10.png",
  "2,1,2,2": "/showcase/tilesets/sand-grass-tile-08-wang-11.png",
  "2,2,1,1": "/showcase/tilesets/sand-grass-tile-03-wang-12.png",
  "2,2,1,2": "/showcase/tilesets/sand-grass-tile-00-wang-13.png",
  "2,2,2,1": "/showcase/tilesets/sand-grass-tile-13-wang-14.png",
  "2,2,2,2": "/showcase/tilesets/sand-grass-tile-12-wang-15.png",
};
