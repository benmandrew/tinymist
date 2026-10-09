import { describe, expect, it } from "vitest";
import { postReplaceNonSVGElements, preReplaceNonSVGElements } from "./typst-patch.svg.mjs";

/// A minimal stand-in for the DOM operations used by the non-`<g>` patching.
class MockElement {
  parent?: MockElement;
  children: MockElement[] = [];

  constructor(
    public tagName: string,
    public key: string,
  ) {}

  static tree(tagName: string, children: MockElement[]): MockElement {
    const elem = new MockElement(tagName, "");
    for (const child of children) {
      elem.append(child);
    }
    return elem;
  }

  isEqualNode(other: MockElement): boolean {
    return this.tagName === other.tagName && this.key === other.key;
  }

  remove() {
    if (this.parent) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = undefined;
    }
  }

  replaceWith(other: MockElement) {
    other.remove();
    const parent = this.parent!;
    parent.children[parent.children.indexOf(this)] = other;
    other.parent = parent;
    this.parent = undefined;
  }

  insertBefore(elem: MockElement, ref: MockElement) {
    elem.remove();
    this.children.splice(this.children.indexOf(ref), 0, elem);
    elem.parent = this;
  }

  append(elem: MockElement) {
    elem.remove();
    this.children.push(elem);
    elem.parent = this;
  }
}

const el = (tagName: string, key: string) => new MockElement(tagName, key);

/// Run the non-`<g>` patching around an unchanged `<g>` sequence.
const patch = (prev: MockElement, next: MockElement) => {
  const frozen = preReplaceNonSVGElements(prev as unknown as Element, next as unknown as Element);
  postReplaceNonSVGElements(prev as unknown as Element, frozen);
};

describe("replaceNonSVGElements", () => {
  it("keepsEqualLeadingElements", () => {
    const rect = el("rect", "page-0");
    const clip = el("clipPath", "clip-0");
    const page = el("g", "page-0");
    const prev = MockElement.tree("svg", [rect, clip, page]);
    const next = MockElement.tree("svg", [
      el("rect", "page-0"),
      el("clipPath", "clip-0"),
      el("g", "page-0"),
    ]);

    patch(prev, next);

    expect(prev.children[0]).toBe(rect);
    expect(prev.children[1]).toBe(clip);
    expect(prev.children[2]).toBe(page);
  });

  it("replacesOnlyChangedLeadingElements", () => {
    const rect = el("rect", "page-0");
    const clip = el("clipPath", "clip-0");
    const newClip = el("clipPath", "clip-0-resized");
    const prev = MockElement.tree("svg", [rect, clip, el("g", "page-0")]);
    const next = MockElement.tree("svg", [el("rect", "page-0"), newClip, el("g", "page-0")]);

    patch(prev, next);

    expect(prev.children[0]).toBe(rect);
    expect(prev.children[1]).toBe(newClip);
    expect(prev.children.map((c) => c.key)).toEqual(["page-0", "clip-0-resized", "page-0"]);
  });

  it("replacesLeadingRunOfDifferentLength", () => {
    const prev = MockElement.tree("svg", [el("rect", "page-0"), el("g", "page-0")]);
    const newRect = el("rect", "page-0");
    const next = MockElement.tree("svg", [newRect, el("rect", "page-1"), el("g", "page-0")]);

    patch(prev, next);

    expect(prev.children[0]).toBe(newRect);
    expect(prev.children.map((c) => c.tagName + ":" + c.key)).toEqual([
      "rect:page-0",
      "rect:page-1",
      "g:page-0",
    ]);
  });

  it("replacesElementsAfterFirstG", () => {
    const between = el("rect", "between");
    const trailing = el("rect", "trailing");
    const prev = MockElement.tree("svg", [el("g", "page-0"), between, el("g", "page-1"), trailing]);
    const next = MockElement.tree("svg", [
      el("g", "page-0"),
      el("rect", "between"),
      el("g", "page-1"),
      el("rect", "trailing"),
    ]);

    patch(prev, next);

    expect(prev.children[1]).not.toBe(between);
    expect(prev.children[3]).not.toBe(trailing);
    expect(prev.children.map((c) => c.key)).toEqual(["page-0", "between", "page-1", "trailing"]);
  });
});
