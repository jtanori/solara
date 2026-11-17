import React from "react";
import { createRoot } from "react-dom/client";
import { ReadingGenerationControls } from "../../src/components/reading-generation-controls";

type Props = React.ComponentProps<typeof ReadingGenerationControls>;
declare global { interface Window { readingProps: Props; mountReadingControls: (props: Props) => void; readingRefreshes: number } }
const root = createRoot(document.getElementById("root")!);
window.mountReadingControls = props => root.render(<ReadingGenerationControls {...props} />);
window.mountReadingControls(window.readingProps);
