import { defineEval } from "eve/evals";

export default defineEval({
  description: "A plain question with no attachment does not trigger any tool call.",
  async test(t) {
    const turn = await t.send("Hola, ¿qué tipo de archivos podés procesar?");

    t.succeeded();
    t.usedNoTools();
    t.judge.autoevals.closedQA(
      "The reply explains which invoice file formats are accepted, in Spanish, without claiming to have read or saved any invoice.",
    );
  },
});
