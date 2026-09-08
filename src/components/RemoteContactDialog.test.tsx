import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RemoteContactDialog } from "./RemoteContactDialog";

describe("RemoteContactDialog", () => {
  it("accepts remote addresses without requiring a protocol", () => {
    const markup = renderToStaticMarkup(
      <RemoteContactDialog
        open
        onClose={() => undefined}
        onConnect={async () => undefined}
      />,
    );

    expect(markup).toContain('type="text"');
    expect(markup).toContain('inputMode="url"');
    expect(markup).toContain("You may omit http://");
    expect(markup).toContain("localhost:2222/");
  });
});
