import React from "react";

export const Screen: React.FC<{ children: React.ReactNode }> = ({
	children,
}) => {
	return <div className="min-h-screen flex flex-col w-full">{children}</div>;
};
