// Self-contained for serialization into the isolated synthetic-media fixture.
export function screenImageQuality(
  reference: Uint8ClampedArray,
  decoded: Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    reference.length !== width * height * 4 ||
    decoded.length !== reference.length
  )
    throw new Error('Invalid quality image dimensions.');
  let squaredError = 0,
    rgbSquaredError = 0,
    similarity = 0,
    detailSimilarity = 0,
    detailBlocks = 0,
    blocks = 0;
  const luma = (pixels: Uint8ClampedArray, offset: number) =>
    (pixels[offset]! * 77 + pixels[offset + 1]! * 150 + pixels[offset + 2]! * 29) / 256;
  for (let y = 0; y < height; y += 8)
    for (let x = 0; x < width; x += 8) {
      let sumA = 0,
        sumB = 0,
        squaresA = 0,
        squaresB = 0,
        products = 0,
        count = 0;
      for (let dy = y; dy < Math.min(y + 8, height); dy++)
        for (let dx = x; dx < Math.min(x + 8, width); dx++) {
          const offset = (dy * width + dx) * 4;
          const a = luma(reference, offset),
            b = luma(decoded, offset);
          squaredError += (a - b) ** 2;
          for (let channel = 0; channel < 3; channel++)
            rgbSquaredError += (reference[offset + channel]! - decoded[offset + channel]!) ** 2;
          sumA += a;
          sumB += b;
          squaresA += a * a;
          squaresB += b * b;
          products += a * b;
          count++;
        }
      const meanA = sumA / count,
        meanB = sumB / count;
      const varianceA = Math.max(0, squaresA / count - meanA * meanA),
        varianceB = Math.max(0, squaresB / count - meanB * meanB);
      const covariance = products / count - meanA * meanB;
      const c1 = (0.01 * 255) ** 2,
        c2 = (0.03 * 255) ** 2;
      const score =
        ((2 * meanA * meanB + c1) * (2 * covariance + c2)) /
        ((meanA ** 2 + meanB ** 2 + c1) * (varianceA + varianceB + c2));
      similarity += score;
      if (varianceA >= 100) {
        detailSimilarity += score;
        detailBlocks++;
      }
      blocks++;
    }
  const mse = squaredError / (width * height);
  const rgbMse = rgbSquaredError / (width * height * 3);
  return {
    lumaPsnrDb: mse === 0 ? null : 10 * Math.log10(255 ** 2 / mse),
    rgbPsnrDb: rgbMse === 0 ? null : 10 * Math.log10(255 ** 2 / rgbMse),
    exact: rgbMse === 0,
    blockSsim: similarity / blocks,
    detailBlockSsim: detailBlocks ? detailSimilarity / detailBlocks : null,
  };
}
