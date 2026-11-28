# L5 — photo-textured tote walls (flag `simPhotoWall`, sim only, default off)

Real tote walls have seams, bevels, scuffs and uneven plastic that a flat-grey synthetic wall lacks. L5 lets the
simulator draw a real photo of a tote face instead, while the barcode stays analytic (so ground truth stays exact).

## Making a wall (`tools/img2wall.mjs`, offline, no deps)

```
node tools/img2wall.mjs <photo.pgm[.gz]> --corners x0,y0,x1,y1,x2,y2,x3,y3 --label-rect u0,v0,u1,v1 --out tests/fixtures-sim/walls/<name>
```

- `corners`: the four corners of the tote face in the photo (TL, TR, BR, BL, pixel-edge coordinates).
- The photo is homography-warped to a 448 x 512 texture (32 texels per inch) standing for the whole 14 x 16 in tote face.
- `label-rect` (0..1 of the face) is masked and filled from its left and right neighbours plus matched grain, so the
  photographed label does not show through under the synthetic one.
- Measured and stored in the `.json` sidecar: paper and ink albedo (from the label), tote albedo and local contrast.
  The renderer draws the analytic barcode at the measured paper/ink, so the label contrast matches the photo.
- Output: `<name>.pgm.gz` + `<name>.json`. `loadWallFile(base)` returns the wall object.
- Committed fixture: `tests/fixtures-sim/walls/tote-tsX07wz7py1` (from the existing real still; that still is one large label, so most of this texture is the filled-in label region. Real head-on tote photos (S10) will replace it).

## Using it

`scene.wallTexture = wall` (or `applySimPhotoWall(scene, { simPhotoWall, wall })`, which does nothing while the flag is off).
Both renderers do the same lookup: bilinear, with a mip level chosen from the pixel footprint on the wall (box-averaged
pyramid, built once per wall in `preparePhotoWall`). `webgl-wall.js` takes the texture on unit 1 via `setPhotoWall(wall)`
(hardware derivatives pick the mip on WebGL2, bilinear only on WebGL1). With no wall, shader and CPU paths are unchanged.

## Checks (`tests/photo-wall.test.js`)

Head-on render at the photo's own scale equals the texture outside the label (mean 0.0/255; limit 8/255), mip averaging
instead of aliasing, decode still succeeds on the photo wall, flag off is bit-for-bit, texture lookup allocates nothing.
