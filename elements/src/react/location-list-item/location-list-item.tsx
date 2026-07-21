import * as React from "react";
import { createComponent } from "@lit/react";
import { LocationListItem as UrLocationListItemElement } from "../../components/location-list-item/location-list-item.js";

export const LocationListItem = createComponent({
	tagName: "ur-location-list-item",
	elementClass: UrLocationListItemElement,
	react: React,
	events: {
		onClick: "click",
	},
});

export interface LocationListItemProps {
	locationKey: string;
	name?: string;
	providerCount?: number;
	unstable?: boolean;
	strongPrivacy?: boolean;
	onClick?: () => void;
	className?: string;
	style?: React.CSSProperties;
}

export const UrLocationListItem = React.forwardRef<
	UrLocationListItemElement,
	LocationListItemProps
>((props, ref) => {
	return <LocationListItem ref={ref} {...props} />;
});

UrLocationListItem.displayName = "UrLocationListItem";

export { UrLocationListItemElement };
export default UrLocationListItem;
