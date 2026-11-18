import React from "react";
import { createRoot } from "react-dom/client";
import { PaidReadingControls } from "../../src/components/paid-reading-controls";
type Props = React.ComponentProps<typeof PaidReadingControls>;
declare global { interface Window { paidProps: Props; mountPaidControls: (props: Props | null) => void } }
const root = createRoot(document.getElementById("root")!);
window.mountPaidControls = props => root.render(props ? <PaidReadingControls key={`${props.readingId}:${props.locale}`} {...props} /> : null);
window.mountPaidControls(window.paidProps);
