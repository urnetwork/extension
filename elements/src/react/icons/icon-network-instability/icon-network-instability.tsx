import * as React from "react";
import { createComponent } from "@lit/react";
import { IconNetworkInstability as UrIconNetworkInstabilityElement } from "../../../components/icons/icon-network-instability";

export const IconNetworkInstability = createComponent({
	tagName: "ur-icon-network-instability",
	elementClass: UrIconNetworkInstabilityElement,
	react: React,
});

export interface IconNetworkInstabilityProps {
	className?: string;
	style?: React.CSSProperties;
	iconTitle?: string;
}

export const UrIconNetworkInstability = React.forwardRef<
	UrIconNetworkInstabilityElement,
	IconNetworkInstabilityProps
>((props, ref) => {
	return <IconNetworkInstability ref={ref} {...props} />;
});

UrIconNetworkInstability.displayName = "UrIconNetworkInstability";

export { UrIconNetworkInstabilityElement };
export default UrIconNetworkInstability;
