import { describe, expect, it } from "vitest"
import setup from "../src/index.ts"

describe("extension scaffold", () => {
    it("exports a setup function", () => {
        expect(setup).toBeTypeOf("function")
    })
})
