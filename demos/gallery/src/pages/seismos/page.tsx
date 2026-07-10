/**
 * page.tsx — seismos as a shell page. No activate/deactivate: everything here
 * is event-driven (DuckDB runs queries when a Selection changes, and nothing
 * changes selections on a hidden page), so an off-route seismos costs nothing
 * by construction — the loaded table stays warm in the durable store for the
 * next visit.
 */
import "./page.css";
import "./graph"; // builds the cell graph + registers window.__seismos
import type { GalleryPage } from "../../site/pages";
import { App } from "./ui/App";

export const page: GalleryPage = {
  title: "seismos — aiui demo app",
  App,
};
