"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const dom = require("../lib/dom");

function ax(role, name, extra) {
  return { role: { value: role }, name: { value: name || "" }, ...(extra || {}) };
}

test("condense keeps interactive roles, skips ignored and nameless text", () => {
  const { nodes, refs, truncated } = dom.sbCondenseAXTree([
    ax("button", "New repository", { backendDOMNodeId: 11 }),
    ax("StaticText", ""), // noise
    ax("StaticText", "Welcome back"), // named text stays
    { role: { value: "link" }, ignored: true, name: { value: "x" } },
    ax("textbox", "Search", { value: { value: "hello" }, backendDOMNodeId: 22 }),
  ]);
  assert.equal(truncated, false);
  assert.deepEqual(nodes, [
    { ref: "1", role: "button", name: "New repository" },
    { ref: "2", role: "StaticText", name: "Welcome back" },
    { ref: "3", role: "textbox", name: "Search", value: "hello" },
  ]);
  assert.deepEqual(refs, { 1: 11, 2: null, 3: 22 });
});

test("refs restart per snapshot and cap at the limit with truncated flag", () => {
  const big = Array.from({ length: 10 }, (_, i) => ax("button", "b" + i));
  const small = dom.sbCondenseAXTree(big, { limit: 4 });
  assert.equal(small.nodes.length, 4);
  assert.equal(small.truncated, true);
  assert.deepEqual(small.nodes.map((n) => n.ref), ["1", "2", "3", "4"]);
  const again = dom.sbCondenseAXTree(big.slice(0, 2));
  assert.deepEqual(again.nodes.map((n) => n.ref), ["1", "2"]);
  assert.equal(again.truncated, false);
});

test("spinbutton (number inputs) condenses with its value", () => {
  const { nodes } = dom.sbCondenseAXTree([ax("spinbutton", "Quantity", { value: { value: "2" }, backendDOMNodeId: 7 })]);
  assert.deepEqual(nodes, [{ ref: "1", role: "spinbutton", name: "Quantity", value: "2" }]);
});

test("empty or malformed trees condense to nothing, never throw", () => {
  for (const input of [undefined, null, [], [{ bogus: true }]]) {
    const out = dom.sbCondenseAXTree(input);
    assert.deepEqual(out.nodes, []);
    assert.equal(out.truncated, false);
  }
});
