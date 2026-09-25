import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const lightBlock = css.match(/@theme\s*\{([\s\S]*?)\}/)?.[1];
const darkBlock = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}/)?.[1];

function colors(block: string | undefined): Map<string, string> {
  assert.ok(block, "palette block must exist");
  return new Map(
    Array.from(block.matchAll(/--color-([\w-]+):\s*(#[\da-f]{6})\s*;/gi), ([, name, value]) => [name, value.toLowerCase()]),
  );
}

const light = colors(lightBlock);
const darkOverrides = colors(darkBlock);
const dark = new Map([...light, ...darkOverrides]);

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("Warm Paper and Harbor Dark keep the Android palette anchors", () => {
  assert.equal(light.get("brand"), "#2d9cdb");
  assert.equal(light.get("primary"), "#1e6892");
  assert.equal(light.get("page"), "#f7f5f1");
  assert.equal(light.get("surface"), "#ffffff");
  assert.equal(light.get("soft"), "#e3f3fb");
  assert.equal(light.get("ink"), "#0f3449");
  assert.equal(light.get("muted"), "#4b5f6c");
  assert.equal(light.get("line"), "#d5e3e9");
  assert.equal(light.get("success"), "#3c7d72");
  assert.equal(light.get("danger"), "#ff2635");

  assert.equal(dark.get("brand"), "#2d9cdb", "brand logo color stays fixed");
  assert.equal(dark.get("primary"), "#56b3e6");
  assert.equal(dark.get("on-primary"), "#002235");
  assert.equal(dark.get("page"), "#08141c");
  assert.equal(dark.get("surface"), "#0f2230");
  assert.equal(dark.get("soft"), "#16303f");
  assert.equal(dark.get("ink"), "#e2eef5");
  assert.equal(dark.get("muted"), "#a9bcc8");
  assert.equal(dark.get("line"), "#2b4a5c");
  assert.equal(dark.get("success"), "#75c7b0");
  assert.equal(dark.get("danger"), "#ff6b75");
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
});

test("semantic text and status pairs meet 4.5:1 contrast in both modes", () => {
  const pairs = [
    ["ink", "page"],
    ["ink", "surface"],
    ["on-primary", "primary"],
    ["on-danger", "danger"],
    ["on-success-soft", "success-soft"],
    ["on-danger-soft", "danger-soft"],
    ["on-warning-soft", "warning-soft"],
    ["on-selection", "selection"],
  ] as const;

  for (const [mode, palette] of [["light", light], ["dark", dark]] as const) {
    for (const [foreground, background] of pairs) {
      const fg = palette.get(foreground);
      const bg = palette.get(background);
      assert.ok(fg && bg, `${mode}: ${foreground} and ${background} must exist`);
      assert.ok(contrast(fg, bg) >= 4.5, `${mode}: ${foreground} on ${background} must meet 4.5:1`);
    }
  }
});

test("all semantic utilities used by the extension have a dark-mode value", () => {
  for (const name of [
    "primary", "primary-hover", "on-primary", "page", "surface", "soft", "ink", "muted", "line",
    "success", "success-soft", "on-success-soft", "danger", "on-danger", "danger-soft",
    "on-danger-soft", "warning", "warning-soft", "on-warning-soft", "disabled", "on-disabled",
  ]) {
    assert.ok(light.has(name), `light ${name}`);
    assert.ok(darkOverrides.has(name), `dark ${name}`);
  }
});

test("text selection stands out on surfaces and soft panels in both modes", () => {
  for (const [mode, palette] of [["light", light], ["dark", dark]] as const) {
    const selection = palette.get("selection");
    assert.ok(selection, `${mode}: selection must exist`);
    for (const background of ["surface", "soft", "page"]) {
      const bg = palette.get(background)!;
      assert.ok(contrast(selection, bg) >= 1.3, `${mode}: selection must be visible on ${background}`);
    }
  }
});
