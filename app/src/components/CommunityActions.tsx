import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMenu, useNotify, type MenuItem } from "trm-ui";
import { useI18n } from "../i18n";
import { openExternal } from "../lib/plaza";
import { Btn } from "./ui";

type CommunityLinks = {
  enabled: boolean;
  publishUrl: string | null;
  submissionsUrl: string | null;
  accountUrl: string | null;
};

type AccountStatus = {
  signedIn: boolean;
  displayName: string | null;
  email: string | null;
  offline: boolean;
};

type AccountAction = "sign_in" | "sign_out";

export function CommunityActions() {
  const [links, setLinks] = useState<CommunityLinks>();
  const [account, setAccount] = useState<AccountStatus>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<AccountAction>();
  const { t } = useI18n();
  const { tip } = useNotify();
  const menu = useMenu();

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true;
    async function load() {
      try {
        const next = await invoke<CommunityLinks>("community_links");
        if (!active || !next.enabled) return;
        setLinks(next);
        const status = await invoke<AccountStatus>("community_account_status");
        if (active) setAccount(status);
      } catch {
        // A missing session still lets the user sign in.
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  if (!links) return null;

  const open = (url: string) => {
    void openExternal(url).catch(() => tip(t("community.linkFailed")));
  };
  const run = async (next: AccountAction) => {
    setAction(next);
    try {
      setAccount(await invoke<AccountStatus>(next === "sign_in" ? "community_account_sign_in" : "community_account_sign_out"));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "canceled") return;
      tip(t(next === "sign_in" ? "community.signInFailed" : "community.signOutFailed"));
    } finally {
      setAction(undefined);
    }
  };

  const { publishUrl } = links;
  const name = account?.displayName || account?.email || t("community.account");
  const items: MenuItem[] = [];
  if (account?.email && account.email !== name) {
    items.push({ id: "email", label: account.email, disabled: true });
  }
  if (links.submissionsUrl) {
    const url = links.submissionsUrl;
    items.push({ id: "submissions", label: t("community.submissions"), onSelect: () => open(url) });
  }
  if (links.accountUrl) {
    const url = links.accountUrl;
    items.push({ id: "account", label: t("community.manageAccount"), onSelect: () => open(url) });
  }
  items.push({ id: "signOut", label: t("community.signOut"), onSelect: () => void run("sign_out") });

  return (
    <>
      {publishUrl ? <Btn onClick={() => open(publishUrl)}>{t("community.publish")}</Btn> : null}
      {account?.signedIn ? (
        <Btn busy={action === "sign_out"} ariaLabel={name} onClick={(event) => menu.open(event.currentTarget, items)}>
          <span className="block max-w-40 truncate" title={name}>{name}</span>
        </Btn>
      ) : (
        <Btn disabled={loading} busy={action === "sign_in"} onClick={() => void run("sign_in")}>{t("community.signIn")}</Btn>
      )}
      {menu.node}
    </>
  );
}
