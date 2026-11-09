import { lazy } from "react";

export const HelpPage = lazy(() => import("./HelpPage").then(module => ({ default: module.HelpPage })));
export const AnnotPage = lazy(() => import("./AnnotPage").then(module => ({ default: module.AnnotPage })));
export const ModelsPage = lazy(() => import("./ModelsPage").then(module => ({ default: module.ModelsPage })));
export const MorePage = lazy(() => import("./MorePage").then(module => ({ default: module.MorePage })));
export const PlazaPage = lazy(() => import("./PlazaPage").then(module => ({ default: module.PlazaPage })));
export const SettingsPage = lazy(() => import("./SettingsPage").then(module => ({ default: module.SettingsPage })));
export const SynthPage = lazy(() => import("./SynthPage").then(module => ({ default: module.SynthPage })));
export const TrainPage = lazy(() => import("./TrainPage").then(module => ({ default: module.TrainPage })));
