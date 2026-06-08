import temml from "temml";
export function latexToMathMl(latex) {
    const source = latex.trim();
    if (!source) {
        return { ok: false, error: "No LaTeX provided." };
    }
    try {
        const mathml = temml.renderToString(source, {
            displayMode: true,
            throwOnError: true,
            trust: false,
            maxSize: [20, 20],
            maxExpand: 1000
        }).trim();
        if (!mathml.startsWith("<math")) {
            return { ok: false, error: "Temml did not return a MathML root element." };
        }
        return { ok: true, mathml };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Unable to convert LaTeX to MathML."
        };
    }
}
