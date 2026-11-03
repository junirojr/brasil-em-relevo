import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeTerritory,
  completeTransition,
  createNavigationState,
  getAllUfs,
  isNationalView,
  isTerritoryTransitioning,
  isValidUf,
  reduceNavigation,
  resolveUfCode,
  resolveUfName,
  resolveUfSigla,
  selectActiveUf,
  startTransition,
  TERRITORY_CHANGED,
  TRANSITION_COMPLETED,
  TRANSITION_STARTED,
} from "./navigation-slice.js";

test("NAV-01 initial navigation state defaults to national view", () => {
  const state = createNavigationState();
  assert.equal(selectActiveUf(state), null);
  assert.equal(isNationalView(state), true);
});

test("NAV-02 changeTerritory switches to specific state using IBGE code or sigla", () => {
  const initial = createNavigationState();
  const stateSpCode = reduceNavigation(initial, changeTerritory("35"));
  assert.equal(selectActiveUf(stateSpCode), "35");
  assert.equal(isNationalView(stateSpCode), false);

  const stateRjSigla = reduceNavigation(stateSpCode, changeTerritory("RJ"));
  assert.equal(selectActiveUf(stateRjSigla), "RJ");
  assert.equal(isNationalView(stateRjSigla), false);
});

test("NAV-03 switching back to null, empty string, or BR restores national view", () => {
  const activeState = createNavigationState("35");
  assert.equal(isNationalView(activeState), false);

  const toNull = reduceNavigation(activeState, changeTerritory(null));
  assert.equal(selectActiveUf(toNull), null);
  assert.equal(isNationalView(toNull), true);

  const backToSp = reduceNavigation(toNull, changeTerritory("SP"));
  const toEmpty = reduceNavigation(backToSp, changeTerritory(""));
  assert.equal(selectActiveUf(toEmpty), null);
  assert.equal(isNationalView(toEmpty), true);

  const toBr = reduceNavigation(
    reduceNavigation(toEmpty, changeTerritory("MG")),
    changeTerritory("BR"),
  );
  assert.equal(selectActiveUf(toBr), null);
  assert.equal(isNationalView(toBr), true);
});

test("NAV-04 dispatching the same active UF returns identical state reference", () => {
  const initial = createNavigationState("35");
  const repeated = reduceNavigation(initial, changeTerritory("35"));
  assert.equal(repeated, initial);

  const national = createNavigationState(null);
  const repeatedNational = reduceNavigation(national, changeTerritory(null));
  assert.equal(repeatedNational, national);
});

test("NAV-05 unknown or invalid UF string is rejected and returns unchanged state reference", () => {
  const initial = createNavigationState("35");
  const invalid = reduceNavigation(initial, changeTerritory("XX"));
  assert.equal(invalid, initial);

  const invalidNumber = reduceNavigation(initial, changeTerritory("999"));
  assert.equal(invalidNumber, initial);

  const invalidAction = reduceNavigation(initial, {
    type: TERRITORY_CHANGED,
    uf: "XYZ_INVALID",
  });
  assert.equal(invalidAction, initial);
});

test("NAV-06 unrelated action types return unchanged state reference", () => {
  const initial = createNavigationState("SP");
  const otherAction = reduceNavigation(initial, { type: "other/action" });
  assert.equal(otherAction, initial);
});

test("NAV-07 createNavigationState validates initial parameter", () => {
  const validBySigla = createNavigationState("BA");
  assert.equal(selectActiveUf(validBySigla), "BA");

  const validByCode = createNavigationState("29");
  assert.equal(selectActiveUf(validByCode), "29");

  const invalidInit = createNavigationState("INVALID");
  assert.equal(selectActiveUf(invalidInit), null);
  assert.equal(isNationalView(invalidInit), true);
});

test("NAV-08 getAllUfs returns exactly 27 Federative Units sorted by name", () => {
  const ufs = getAllUfs();
  assert.equal(ufs.length, 27);
  assert.equal(Object.isFrozen(ufs), true);

  const codes = new Set(ufs.map((item) => item.code));
  assert.equal(codes.size, 27);

  const siglas = new Set(ufs.map((item) => item.sigla));
  assert.equal(siglas.size, 27);

  assert.equal(codes.has("35"), true);
  assert.equal(siglas.has("SP"), true);

  for (let i = 1; i < ufs.length; i += 1) {
    const prev = ufs[i - 1].name;
    const current = ufs[i].name;
    assert.ok(prev.localeCompare(current, "pt-BR") <= 0);
  }
});

test("NAV-09 helpers resolve UF code, abbreviation and official name accurately", () => {
  assert.equal(isValidUf("35"), true);
  assert.equal(isValidUf("SP"), true);
  assert.equal(isValidUf("sp"), true);
  assert.equal(isValidUf("00"), false);
  assert.equal(isValidUf(null), false);

  assert.equal(resolveUfCode("SP"), "35");
  assert.equal(resolveUfCode("35"), "35");
  assert.equal(resolveUfCode("INVALID"), null);

  assert.equal(resolveUfSigla("35"), "SP");
  assert.equal(resolveUfSigla("SP"), "SP");
  assert.equal(resolveUfSigla("99"), null);

  assert.equal(resolveUfName("35"), "São Paulo");
  assert.equal(resolveUfName("SP"), "São Paulo");
  assert.equal(resolveUfName("33"), "Rio de Janeiro");
  assert.equal(resolveUfName("INVALID"), null);
});

test("NAV-25 transition lifecycle starts transition and sets transitioning flag", () => {
  const initial = createNavigationState();
  assert.equal(isTerritoryTransitioning(initial), false);

  const transitioning = reduceNavigation(initial, startTransition());
  assert.equal(isTerritoryTransitioning(transitioning), true);
  assert.equal(transitioning.isTransitioning, true);

  const redundant = reduceNavigation(transitioning, startTransition());
  assert.equal(redundant, transitioning);
});

test("NAV-26 transition lifecycle completes transition and clears transitioning flag", () => {
  const transitioning = { activeUf: "35", isTransitioning: true };
  const completed = reduceNavigation(transitioning, completeTransition());
  assert.equal(isTerritoryTransitioning(completed), false);
  assert.equal(completed.isTransitioning, false);

  const redundantCompleted = reduceNavigation(completed, completeTransition());
  assert.equal(redundantCompleted, completed);
});

test("NAV-27 territory change updates active UF directly without persistent transitioning flag", () => {
  const initial = createNavigationState(null);
  const directChange = reduceNavigation(initial, changeTerritory("MG"));
  assert.equal(directChange.activeUf, "MG");
  assert.equal(isTerritoryTransitioning(directChange), false);

  const returnToBr = reduceNavigation(directChange, changeTerritory(null));
  assert.equal(returnToBr.activeUf, null);
  assert.equal(isTerritoryTransitioning(returnToBr), false);
});
