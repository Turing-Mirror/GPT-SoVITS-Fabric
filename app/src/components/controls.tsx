/** 组件实现在 TRM UI（vendor: ../trm）。产品侧只经这里引用，换实现时页面不用改。 */
import { Dropdown } from "../trm";
import { t } from "../i18n";

export { Field, RangeBar, Slider, SliderValue, Toggle } from "../trm";

/** 下拉选择。用 TRM 的 Dropdown 代替原生 select，与 RVC Fabric 一致。
 *  已保存的值不在列表里时保留并注明，空列表时显示占位项。 */
export function Select({
  value,
  options,
  onChange,
  full = false,
  width,
  disabled = false,
}: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
  full?: boolean;
  width?: number;
  disabled?: boolean;
}) {
  const missing = Boolean(value) && !options.some((o) => o.id === value);
  const list = [
    ...(options.length === 0 && !missing ? [{ id: "", label: t("ui.select.empty") }] : []),
    ...(missing ? [{ id: value, label: `${value}${t("ui.select.missing")}` }] : []),
    ...options,
  ];
  return (
    <div
      className={[full ? "w-full" : "inline-flex", disabled ? "opacity-50 pointer-events-none" : ""].join(" ")}
      style={width ? { minWidth: width } : undefined}
      aria-disabled={disabled || undefined}
    >
      <Dropdown value={value} options={list} onChange={onChange} full={full || Boolean(width)} />
    </div>
  );
}
