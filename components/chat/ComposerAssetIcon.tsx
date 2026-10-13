import type { CSSProperties, HTMLAttributes } from "react";

type ComposerAssetIconProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children"
>;

function ComposerAssetIcon({
  asset,
  width,
  height,
  className,
  style,
  ...props
}: ComposerAssetIconProps & {
  asset: string;
  width: number;
  height: number;
}) {
  const maskStyle: CSSProperties = {
    display: "inline-block",
    flexShrink: 0,
    width,
    height,
    backgroundColor: "currentColor",
    maskImage: `url(${asset})`,
    maskPosition: "center",
    maskRepeat: "no-repeat",
    maskSize: "contain",
    WebkitMaskImage: `url(${asset})`,
    WebkitMaskPosition: "center",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskSize: "contain",
    ...style,
  };

  return <span className={className} style={maskStyle} {...props} />;
}

export function ComposerPlusIcon(props: ComposerAssetIconProps) {
  return (
    <ComposerAssetIcon
      asset="/assets/composer-compact/icon-plus.svg"
      width={21}
      height={21}
      {...props}
    />
  );
}

export function ComposerChevronDownIcon(props: ComposerAssetIconProps) {
  return (
    <ComposerAssetIcon
      asset="/assets/composer-compact/icon-chevron-down-14.svg"
      width={14}
      height={14}
      {...props}
    />
  );
}

export function ComposerCreditChevronIcon(props: ComposerAssetIconProps) {
  return (
    <ComposerAssetIcon
      asset="/assets/composer-compact/icon-chevron-down-12.svg"
      width={12}
      height={12}
      {...props}
    />
  );
}

export function ComposerCoinsIcon(props: ComposerAssetIconProps) {
  return (
    <ComposerAssetIcon
      asset="/assets/composer-compact/icon-coins.svg"
      width={15}
      height={15}
      {...props}
    />
  );
}

export function ComposerMicIcon(props: ComposerAssetIconProps) {
  return (
    <ComposerAssetIcon
      asset="/assets/composer-compact/icon-mic.svg"
      width={21}
      height={21}
      {...props}
    />
  );
}

export function ComposerArrowUpIcon(props: ComposerAssetIconProps) {
  return (
    <ComposerAssetIcon
      asset="/assets/composer-compact/icon-arrow-up.svg"
      width={21}
      height={21}
      {...props}
    />
  );
}

export function ComposerGlobeIcon(props: ComposerAssetIconProps) {
  return (
    <ComposerAssetIcon
      asset="/assets/composer-compact/icon-globe.svg"
      width={16}
      height={16}
      {...props}
    />
  );
}
