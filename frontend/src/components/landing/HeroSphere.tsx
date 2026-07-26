import Image from "next/image";

/**
 * The hero's ribbon-sphere render.
 *
 * A still image, not the Spline iframe it replaced: the embed shipped its own
 * headline, its own CTA and a vendor badge, and could not be made transparent
 * from the embedding side.
 *
 * The PNG in `public/` has **real alpha**. It was delivered as a composite over
 * pure black, which is the same thing as premultiplied alpha over a zero
 * background, so straight alpha was recovered exactly — `alpha = max(r,g,b)`,
 * then un-premultiply each channel. That replaced an earlier
 * `mix-blend-mode: screen` trick which knocked the black out only against dark
 * surfaces; under the light theme screen blending against an off-white page
 * blows the whole sphere out to white. Real transparency composites correctly
 * on both themes and needs no blend mode, no stacking-context care, and no
 * explicit background on the section behind it.
 */
export function HeroSphere() {
  return (
    // Hidden below 768px: the hero stacks there and this is decorative, so a
    // ~200KB render is not worth the bytes on a phone.
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-0 hidden w-[52%] items-center justify-center md:flex"
    >
      <Image
        src="/ribbon-sphere.png"
        alt=""
        width={1326}
        height={663}
        priority
        className="h-auto w-full max-w-[680px]"
      />
    </div>
  );
}
