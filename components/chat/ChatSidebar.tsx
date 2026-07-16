"use client";

import { Conversation } from "./types";
import { getModel } from "@/components/chat/types";
import { AuthButton } from "@/components/auth/AuthButton";
import { useCallback, useState, useEffect, useId, useRef, useSyncExternalStore } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import Link from "next/link";
import { AlertTriangle, Check, ChevronDown, CircleHelp, CloudUpload, Crown, Database, Download, Folder, FolderPlus, Link2Off, Lock, MessageSquare, MoreVertical, Pencil, Pin, Search, Send, Share2, ShieldCheck, SlidersHorizontal, Sparkles, Star, Tag, Trash2, Unlock, X } from "lucide-react";
import { FeedbackButton } from "@/components/chat/FeedbackButton";
import { UserUsageSummary } from "@/components/chat/UserUsageSummary";
import { FeatureHelpPopover } from "@/components/chat/FeatureHelpPopover";
import { chatHelpCopy } from "@/components/chat/chatHelpCopy";
import { useUserUsage, type UserPlan } from "@/components/chat/useUserUsage";
import { dispatchAppToast } from "@/lib/appToast";
import { trackProductEvent, trackProductEventOnce } from "@/lib/productAnalyticsClient";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";

type ChatSidebarProps = {
    conversations: Conversation[];
    currentChatId: string | null;
    isGuestMode?: boolean;
    guestMessageCount?: number;
    maxGuestMessages?: number;
    onNewChat: () => void;
    onSelectConversation: (id: string) => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    onLock?: (id: string, password: string) => void;
    onUnlock?: (id: string) => void;
    onShare: (id: string, title: string) => void;
    onRevokeShare: (id: string) => void;
    onDownload: (id: string, title: string) => void;    
    isPrivateMode?: boolean;
    onTogglePrivateMode: () => void;
    currentModelId?: string | null;
    attachmentCount?: number;
    isMobileDrawer?: boolean;
};

type ConversationFilter = "all" | "locked" | "shared" | "work" | "research" | "personal" | `project:${string}`;

type ConversationProject = {
    id: string;
    name: string;
    conversationCount?: number;
};

const SIDEBAR_TOUR_STORAGE_KEY = "tomverse_sidebar_tour_v1";
const ORGANIZER_STORAGE_KEY = "tomverse_sidebar_organizer_v1";
const ORGANIZER_CHANGE_EVENT = "tomverse-sidebar-organizer-change";
const SHORT_SIDEBAR_MEDIA_QUERY = "(max-height: 860px)";

type OrganizerPreference = "auto" | "expanded" | "collapsed";

const subscribeOrganizerPreference = (onStoreChange: () => void) => {
    window.addEventListener("storage", onStoreChange);
    window.addEventListener(ORGANIZER_CHANGE_EVENT, onStoreChange);
    return () => {
        window.removeEventListener("storage", onStoreChange);
        window.removeEventListener(ORGANIZER_CHANGE_EVENT, onStoreChange);
    };
};

const getOrganizerPreference = (): OrganizerPreference => {
    const stored = localStorage.getItem(ORGANIZER_STORAGE_KEY);
    return stored === "expanded" || stored === "collapsed" ? stored : "auto";
};

const getServerOrganizerPreference = (): OrganizerPreference => "auto";

const subscribeShortSidebar = (onStoreChange: () => void) => {
    const mediaQuery = window.matchMedia(SHORT_SIDEBAR_MEDIA_QUERY);
    mediaQuery.addEventListener("change", onStoreChange);
    return () => mediaQuery.removeEventListener("change", onStoreChange);
};

const getShortSidebarSnapshot = () => window.matchMedia(SHORT_SIDEBAR_MEDIA_QUERY).matches;
const getServerShortSidebarSnapshot = () => false;

export function ChatSidebar({
    conversations,
    currentChatId,
    isGuestMode,
    guestMessageCount,
    maxGuestMessages,
    onNewChat,
    onSelectConversation,
    onRename,
    onDelete,
    onLock,
    onUnlock,
    onShare,
    onRevokeShare,
    onDownload,    
    isPrivateMode = false,
    onTogglePrivateMode,
    currentModelId,
    attachmentCount = 0,
    isMobileDrawer = false,
}: ChatSidebarProps) {
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [showPrivateNotice, setShowPrivateNotice] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [conversationFilter, setConversationFilter] = useState<ConversationFilter>("all");
    const [showProjectForm, setShowProjectForm] = useState(false);
    const [projectName, setProjectName] = useState("");
    const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
    const [editingProjectName, setEditingProjectName] = useState("");
    const [deleteProjectArmedId, setDeleteProjectArmedId] = useState<string | null>(null);
    const [conversationProjectOverrides, setConversationProjectOverrides] = useState<Record<string, string | null>>({});
    const [projects, setProjects] = useState<ConversationProject[]>([]);
    const [isCreatingProject, setIsCreatingProject] = useState(false);
    const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
    const [conversationLabels, setConversationLabels] = useState<Record<string, string>>(() => {
        if (typeof window === "undefined") return {};
        try {
            const saved = JSON.parse(localStorage.getItem("tomverse_conversation_labels") || "{}");
            if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
            return Object.fromEntries(
                Object.entries(saved).filter(
                    (entry): entry is [string, string] =>
                        typeof entry[0] === "string" && typeof entry[1] === "string"
                )
            );
        } catch {
            return {};
        }
    });
    const [pinnedConversationIds, setPinnedConversationIds] = useState<string[]>(() => {
        if (typeof window === "undefined") return [];
        try {
            const saved = JSON.parse(localStorage.getItem("tomverse_pinned_conversations") || "[]");
            return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
        } catch {
            return [];
        }
    });
    const [favoriteConversationIds, setFavoriteConversationIds] = useState<string[]>(() => {
        if (typeof window === "undefined") return [];
        try {
            const saved = JSON.parse(localStorage.getItem("tomverse_favorite_conversations") || "[]");
            return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
        } catch {
            return [];
        }
    });
    const [messageSearchResults, setMessageSearchResults] = useState<Array<{
        id: string;
        conversationId: string;
        conversationTitle: string;
        snippet: string;
    }>>([]);
    const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
    const [shareTarget, setShareTarget] = useState<Conversation | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [lockTarget, setLockTarget] = useState<Conversation | null>(null);
    const [lockPassword, setLockPassword] = useState("");
    const [lockError, setLockError] = useState("");
    const privateModeButtonRef = useRef<HTMLButtonElement | null>(null);
    const privateNoticeDialogRef = useRef<HTMLDivElement | null>(null);
    const helpMenuRef = useRef<HTMLSpanElement | null>(null);
    const [showHelpMenu, setShowHelpMenu] = useState(false);
    const [sidebarTourStep, setSidebarTourStep] = useState<number | null>(null);
    const organizerPreference = useSyncExternalStore(
        subscribeOrganizerPreference,
        getOrganizerPreference,
        getServerOrganizerPreference
    );
    const hasShortSidebar = useSyncExternalStore(
        subscribeShortSidebar,
        getShortSidebarSnapshot,
        getServerShortSidebarSnapshot
    );
    const { t, lang } = useLanguage();
    const helpCopy = chatHelpCopy[lang];
    const tooltipIdPrefix = useId();
    const helpTooltipId = `${tooltipIdPrefix}-help`;
    const accountUsage = useUserUsage(!isGuestMode);
    const canShare =
        !isGuestMode && accountUsage?.limits.allowSharing !== false;
    const canDownload =
        !isGuestMode && accountUsage?.limits.allowDownloads !== false;
    const displayedPlan: UserPlan | "Guest" | null = isGuestMode ? "Guest" : accountUsage?.plan || null;
    const menuItemBase =
        "flex w-full items-center justify-between whitespace-nowrap rounded px-3 py-2 text-sm transition-colors";

    const menuItemEnabled =
        "cursor-pointer text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100";

    const menuItemDisabled =
        "cursor-not-allowed bg-zinc-900/50 text-zinc-600";

    const organizerExpanded =
        sidebarTourStep !== null ||
        organizerPreference === "expanded" ||
        (organizerPreference === "auto" && !hasShortSidebar && !isMobileDrawer);

    const toggleOrganizer = () => {
        const nextPreference: OrganizerPreference = organizerExpanded ? "collapsed" : "expanded";
        localStorage.setItem(ORGANIZER_STORAGE_KEY, nextPreference);
        window.dispatchEvent(new Event(ORGANIZER_CHANGE_EVENT));
    };

    const menuIconClass = "h-3.5 w-3.5 shrink-0";
    const crownClass = "h-3.5 w-3.5 shrink-0 text-amber-400";
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const messageMatchedIds = new Set(messageSearchResults.map((result) => result.conversationId));
    const getConversationProjectId = (conversation: Conversation) =>
        Object.prototype.hasOwnProperty.call(conversationProjectOverrides, conversation.id)
            ? conversationProjectOverrides[conversation.id]
            : conversation.projectId || null;
    const filteredConversations = conversations.filter((conversation) => {
        const matchesSearch =
            !normalizedSearch ||
            conversation.title.toLowerCase().includes(normalizedSearch) ||
            messageMatchedIds.has(conversation.id);
        const matchesFilter =
            conversationFilter === "all" ||
            (conversationFilter === "locked" && conversation.isLocked) ||
            (conversationFilter === "shared" && conversation.shareEnabled) ||
            (conversationFilter.startsWith("project:")
                ? getConversationProjectId(conversation) === conversationFilter.slice("project:".length)
                : conversationLabels[conversation.id] === conversationFilter);

        return matchesSearch && matchesFilter;
    }).sort((a, b) => {
        const pinnedDelta =
            Number(pinnedConversationIds.includes(b.id)) -
            Number(pinnedConversationIds.includes(a.id));
        if (pinnedDelta !== 0) return pinnedDelta;
        const favoriteDelta =
            Number(favoriteConversationIds.includes(b.id)) -
            Number(favoriteConversationIds.includes(a.id));
        return favoriteDelta;
    });
    const activeLabelFilter =
        conversationFilter === "work" ||
        conversationFilter === "research" ||
        conversationFilter === "personal"
            ? conversationFilter
            : null;

    useEffect(() => {
        if (isGuestMode || normalizedSearch.length < 2) {
            const timer = window.setTimeout(() => setMessageSearchResults([]), 0);
            return () => window.clearTimeout(timer);
        }
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            void fetch(`/api/conversations/search?q=${encodeURIComponent(searchQuery.trim())}`, {
                signal: controller.signal,
                cache: "no-store",
            })
                .then((response) => (response.ok ? response.json() : { results: [] }))
                .then((data) => setMessageSearchResults(Array.isArray(data.results) ? data.results : []))
                .catch(() => {});
        }, 250);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [isGuestMode, normalizedSearch.length, searchQuery]);

    useEffect(() => {
        if (!showHelpMenu) return;
        const closeOnOutsideClick = (event: PointerEvent) => {
            if (!helpMenuRef.current?.contains(event.target as Node)) {
                setShowHelpMenu(false);
            }
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setShowHelpMenu(false);
        };
        document.addEventListener("pointerdown", closeOnOutsideClick);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOnOutsideClick);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [showHelpMenu]);

    useEffect(() => {
        if (isGuestMode || !conversations.some((conversation) => conversation.id !== "private-chat")) {
            return;
        }
        const desktopViewport = window.matchMedia("(min-width: 768px)").matches;
        const visibleSidebar = isMobileDrawer ? !desktopViewport : desktopViewport;
        if (!visibleSidebar || localStorage.getItem(SIDEBAR_TOUR_STORAGE_KEY)) return;
        const timer = window.setTimeout(() => {
            setSidebarTourStep((current) => current ?? 0);
            trackProductEventOnce(
                "sidebar_tour_started:auto:v1",
                "sidebar_tour_started"
            );
        }, 500);
        return () => window.clearTimeout(timer);
    }, [conversations, isGuestMode, isMobileDrawer]);

    useEffect(() => {
        if (!showProjectForm && !editingProjectId && !deleteProjectArmedId) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setShowProjectForm(false);
            setProjectName("");
            setEditingProjectId(null);
            setEditingProjectName("");
            setDeleteProjectArmedId(null);
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [deleteProjectArmedId, editingProjectId, showProjectForm]);

    const toggleStoredId = (storageKey: string, id: string, setter: (ids: string[]) => void) => {
        let next: string[] = [];
        try {
            const current = JSON.parse(localStorage.getItem(storageKey) || "[]");
            const values = Array.isArray(current) ? current.filter((item): item is string => typeof item === "string") : [];
            next = values.includes(id) ? values.filter((item) => item !== id) : [id, ...values];
            localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
            next = [id];
            localStorage.setItem(storageKey, JSON.stringify(next));
        }
        setter(next);
    };

    const togglePinned = (id: string) =>
        toggleStoredId("tomverse_pinned_conversations", id, setPinnedConversationIds);
    const toggleFavorite = (id: string) =>
        toggleStoredId("tomverse_favorite_conversations", id, setFavoriteConversationIds);

    const setConversationLabel = (id: string, label: "work" | "research" | "personal" | null) => {
        setConversationLabels((current) => {
            const next = { ...current };
            if (label) next[id] = label;
            else delete next[id];
            localStorage.setItem("tomverse_conversation_labels", JSON.stringify(next));
            return next;
        });
    };

    useEffect(() => {
        if (isGuestMode) {
            const timer = window.setTimeout(() => setProjects([]), 0);
            return () => window.clearTimeout(timer);
        }
        const controller = new AbortController();
        void fetch("/api/projects", {
            cache: "no-store",
            signal: controller.signal,
        })
            .then((response) => (response.ok ? response.json() : { projects: [] }))
            .then((data) => {
                const nextProjects = Array.isArray(data.projects)
                    ? data.projects
                        .map((item: unknown) => {
                            const project = item as { id?: unknown; name?: unknown; conversationCount?: unknown };
                            return typeof project.id === "string" && typeof project.name === "string"
                                ? {
                                    id: project.id,
                                    name: project.name.slice(0, 32),
                                    conversationCount:
                                        typeof project.conversationCount === "number"
                                            ? project.conversationCount
                                            : undefined,
                                }
                                : null;
                        })
                        .filter((item: ConversationProject | null): item is ConversationProject => Boolean(item))
                    : [];
                setProjects(nextProjects);
            })
            .catch(() => {});
        return () => controller.abort();
    }, [isGuestMode]);

    const createProject = async () => {
        const name = projectName.trim().slice(0, 32);
        if (!name || isCreatingProject) return;
        setIsCreatingProject(true);
        try {
            const response = await fetch("/api/projects", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
            });
            if (!response.ok) {
                dispatchAppToast(t("sidebar.projectRenameFailed"), "error");
                return;
            }
            const project = (await response.json()) as ConversationProject;
            if (!project?.id || !project?.name) {
                dispatchAppToast(t("sidebar.projectRenameFailed"), "error");
                return;
            }
            setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
            setProjectName("");
            setShowProjectForm(false);
            setConversationFilter(`project:${project.id}`);
        } catch {
            dispatchAppToast(t("sidebar.projectRenameFailed"), "error");
        } finally {
            setIsCreatingProject(false);
        }
    };

    const startProjectRename = (project: ConversationProject) => {
        setEditingProjectId(project.id);
        setEditingProjectName(project.name);
        setDeleteProjectArmedId(null);
    };

    const renameProject = async (projectId: string) => {
        if (renamingProjectId) return;
        const name = editingProjectName.trim().slice(0, 32);
        if (!name) return;
        const currentProject = projects.find((project) => project.id === projectId);
        if (currentProject?.name === name) {
            setEditingProjectId(null);
            setEditingProjectName("");
            return;
        }
        const previousProjects = projects;
        setProjects((current) =>
            current.map((project) =>
                project.id === projectId ? { ...project, name } : project
            )
        );
        setRenamingProjectId(projectId);
        try {
            const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                cache: "no-store",
                body: JSON.stringify({ name }),
            });
            if (!response.ok) {
                setProjects(previousProjects);
                dispatchAppToast(t("sidebar.projectRenameFailed"), "error");
                return;
            }
            const project = (await response.json()) as ConversationProject;
            if (!project?.id || !project?.name) {
                setProjects(previousProjects);
                dispatchAppToast(t("sidebar.projectRenameFailed"), "error");
                return;
            }
            setProjects((current) =>
                current.map((item) => (item.id === project.id ? { ...item, ...project } : item))
            );
            setEditingProjectId(null);
            setEditingProjectName("");
        } catch {
            setProjects(previousProjects);
            dispatchAppToast(t("sidebar.projectRenameFailed"), "error");
        } finally {
            setRenamingProjectId(null);
        }
    };

    const deleteProject = async (projectId: string) => {
        if (deleteProjectArmedId !== projectId) {
            setDeleteProjectArmedId(projectId);
            dispatchAppToast(t("sidebar.projectDeleteConfirm"), "info");
            return;
        }
        const previousProjects = projects;
        setProjects((current) => current.filter((project) => project.id !== projectId));
        setConversationProjectOverrides((current) => {
            const next = { ...current };
            conversations.forEach((conversation) => {
                if (getConversationProjectId(conversation) === projectId) {
                    next[conversation.id] = null;
                }
            });
            return next;
        });
        if (conversationFilter === `project:${projectId}`) {
            setConversationFilter("all");
        }
        setDeleteProjectArmedId(null);
        const response = await fetch(`/api/projects/${projectId}`, {
            method: "DELETE",
        });
        if (!response.ok) {
            setProjects(previousProjects);
            dispatchAppToast(t("sidebar.projectDeleteFailed"), "error");
        }
    };

    const setConversationProject = async (conversationId: string, projectId: string | null) => {
        const conversation = conversations.find(
            (item) => item.id === conversationId
        );
        const previousProjectId =
            conversation?.projectId || null;
        setConversationProjectOverrides((current) => ({
            ...current,
            [conversationId]: projectId,
        }));
        const response = await fetch(`/api/conversations/${conversationId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId }),
        });
        if (!response.ok) {
            setConversationProjectOverrides((current) => ({
                ...current,
                [conversationId]: previousProjectId,
            }));
            return;
        }
        if (projectId && projectId !== previousProjectId) {
            const enabledModelCount = (conversation?.selectedModels || []).filter(
                (modelId) =>
                    !(conversation?.disabledPanels || []).includes(modelId)
            ).length;
            trackProductEvent("conversation_saved", enabledModelCount, {
                conversation_mode: "account",
            });
        }
        setProjects((current) =>
            current.map((project) => {
                const wasPrevious = previousProjectId === project.id;
                const isNext = projectId === project.id;
                if (!wasPrevious && !isNext) return project;
                const delta = Number(isNext) - Number(wasPrevious);
                return {
                    ...project,
                    conversationCount:
                        typeof project.conversationCount === "number"
                            ? Math.max(project.conversationCount + delta, 0)
                            : project.conversationCount,
                };
            })
        );
    };

    const labelText = (label: string) => {
        if (label === "work") return t("sidebar.labelWork");
        if (label === "research") return t("sidebar.labelResearch");
        if (label === "personal") return t("sidebar.labelPersonal");
        return label;
    };

    const projectText = (projectId: string) =>
        projects.find((project) => project.id === projectId)?.name || t("sidebar.uncategorizedProject");

    const activeOrganizerSummary = (() => {
        if (conversationFilter === "locked") return helpCopy.lockedFilter;
        if (conversationFilter === "shared") return helpCopy.sharedFilter;
        if (
            conversationFilter === "work" ||
            conversationFilter === "research" ||
            conversationFilter === "personal"
        ) {
            return labelText(conversationFilter);
        }
        if (conversationFilter.startsWith("project:")) {
            return projectText(conversationFilter.slice("project:".length));
        }
        return t("sidebar.organizerNoFilter");
    })();

    const getConversationModelSummary = (conversation: Conversation) => {
        const models = conversation.selectedModels
            ?.map((modelId) => getModel(modelId)?.name)
            .filter(Boolean);

        if (!models?.length) return t("sidebar.noModelInfo");
        if (models.length === 1) return models[0];
        return `${models[0]} +${models.length - 1}`;
    };

    const closePrivateNotice = useCallback((restoreFocus = true) => {
        setShowPrivateNotice(false);
        if (restoreFocus) {
            requestAnimationFrame(() => privateModeButtonRef.current?.focus());
        }
    }, []);

    const startSidebarTour = () => {
        setShowHelpMenu(false);
        setSidebarTourStep(0);
        trackProductEvent("sidebar_tour_started");
    };

    const skipSidebarTour = () => {
        localStorage.setItem(SIDEBAR_TOUR_STORAGE_KEY, "skipped");
        setSidebarTourStep(null);
        trackProductEvent("sidebar_tour_skipped");
    };

    const advanceSidebarTour = () => {
        if (sidebarTourStep === null) return;
        if (sidebarTourStep < helpCopy.tourSteps.length - 1) {
            setSidebarTourStep(sidebarTourStep + 1);
            return;
        }
        localStorage.setItem(SIDEBAR_TOUR_STORAGE_KEY, "completed");
        setSidebarTourStep(null);
        trackProductEvent("sidebar_tour_completed");
    };

    const getPrivateNoticeFocusableElements = useCallback(() => {
        const dialog = privateNoticeDialogRef.current;
        if (!dialog) return [];

        return Array.from(
            dialog.querySelectorAll<HTMLElement>(
                [
                    "button:not([disabled])",
                    "input:not([disabled])",
                    "select:not([disabled])",
                    "textarea:not([disabled])",
                    "a[href]",
                    '[tabindex]:not([tabindex="-1"])',
                ].join(",")
            )
        ).filter((element) => element.offsetParent !== null);
    }, []);

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            const target = event.target as HTMLElement;
            if (!target.closest('.context-menu-wrapper')) {
                setOpenMenuId(null);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    useEffect(() => {
        if (!showPrivateNotice) return;
        const animationFrame = requestAnimationFrame(() => {
            getPrivateNoticeFocusableElements()[0]?.focus();
        });
        return () => cancelAnimationFrame(animationFrame);
    }, [getPrivateNoticeFocusableElements, showPrivateNotice]);

    useEffect(() => {
        if (!showPrivateNotice) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closePrivateNotice(true);
                return;
            }

            if (event.key !== "Tab") return;

            const focusableElements = getPrivateNoticeFocusableElements();
            if (focusableElements.length === 0) {
                event.preventDefault();
                return;
            }

            const firstElement = focusableElements[0];
            const lastElement = focusableElements[focusableElements.length - 1];
            const activeElement = document.activeElement;

            if (event.shiftKey && activeElement === firstElement) {
                event.preventDefault();
                lastElement.focus();
                return;
            }

            if (!event.shiftKey && activeElement === lastElement) {
                event.preventDefault();
                firstElement.focus();
            }
        };
        document.addEventListener("keydown", handleKeyDown, true);
        return () => document.removeEventListener("keydown", handleKeyDown, true);
    }, [closePrivateNotice, getPrivateNoticeFocusableElements, showPrivateNotice]);

    return (
        <>
        <aside className={`relative flex h-full w-full shrink-0 select-none flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 ${isMobileDrawer ? "" : "md:w-80"}`}>

            <div className={`${isMobileDrawer ? "p-3" : "p-4"} border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2.5`}>
                <span className={`flex items-center justify-center overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200 shadow-sm dark:ring-zinc-800 ${isMobileDrawer ? "h-8 w-8" : "h-9 w-9"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src="/tomverse-logo.png"
                        alt="Tomverse AI"
                        className="h-full w-full object-cover"
                    />
                </span>
                <h1 className={`${isMobileDrawer ? "text-sm" : "text-base"} font-bold tracking-tight text-zinc-800 dark:text-zinc-100`}>
                    Tomverse AI
                </h1>
                <span ref={helpMenuRef} className="group/help relative ml-auto inline-flex">
                    <button
                        type="button"
                        aria-label={t("sidebar.helpAndGuides")}
                        aria-describedby={helpTooltipId}
                        aria-expanded={showHelpMenu}
                        aria-haspopup="menu"
                        data-testid="sidebar-help-button"
                        onClick={() => {
                            setShowHelpMenu((current) => !current);
                            trackProductEvent("help_opened", 0, {
                                help_source: "sidebar_header",
                                help_topic: "workspace",
                            });
                        }}
                        className={`inline-flex items-center justify-center rounded-full text-zinc-500 transition hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-zinc-400 dark:hover:bg-blue-950/50 dark:hover:text-blue-300 ${isMobileDrawer ? "h-10 w-10" : "h-8 w-8"}`}
                    >
                        <CircleHelp className="h-5 w-5" aria-hidden="true" />
                    </button>
                    {!showHelpMenu ? (
                        <span
                            id={helpTooltipId}
                            role="tooltip"
                            className="pointer-events-none absolute right-0 top-full z-50 mt-1 hidden w-max max-w-64 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-bold text-zinc-700 shadow-xl group-hover/help:block group-focus-within/help:block dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                        >
                            {t("sidebar.helpAndGuides")}
                        </span>
                    ) : null}
                    {showHelpMenu ? (
                        <span
                            role="menu"
                            className="absolute right-0 top-full z-[75] mt-2 block w-64 rounded-2xl border border-zinc-200 bg-white p-2 text-left shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
                        >
                            <span className="block px-3 py-2 text-xs font-black uppercase tracking-wide text-zinc-500">
                                {helpCopy.quickHelp}
                            </span>
                            <button
                                type="button"
                                role="menuitem"
                                data-testid="sidebar-tour-replay"
                                onClick={startSidebarTour}
                                className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-bold text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                                <Sparkles className="h-4 w-4 text-blue-500" aria-hidden="true" />
                                {helpCopy.replayTour}
                            </button>
                            <Link
                                href={chatWorkspaceGuideHref(lang)}
                                target="_blank"
                                rel="noopener noreferrer"
                                prefetch={false}
                                role="menuitem"
                                data-testid="sidebar-help-link"
                                onClick={() => setShowHelpMenu(false)}
                                className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-bold text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                                <CircleHelp className="h-4 w-4 text-blue-500" aria-hidden="true" />
                                {helpCopy.openFullGuide}
                            </Link>
                        </span>
                    ) : null}
                </span>
            </div>

            <div className={`${isMobileDrawer ? "p-2.5" : "p-3"} border-b border-zinc-200/60 dark:border-zinc-800/40`}>
                <button
                    onClick={onNewChat}
                    className={`w-full cursor-pointer flex items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 text-xs font-semibold text-white transition-all hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 ${isMobileDrawer ? "py-2" : "py-2.5"}`}
                >
                    <span className="text-sm">+</span> {t("sidebar.newChat")}
                </button>

                <div className="mt-2 flex items-center gap-1">
                    <button
                        ref={privateModeButtonRef}
                        onClick={() => {
                            if (isPrivateMode) {
                                onTogglePrivateMode();
                            } else {
                                setShowPrivateNotice(true);
                            }
                        }}
                        disabled={isGuestMode}
                        className={`flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border px-4 text-xs font-semibold transition-all ${isMobileDrawer ? "py-2" : "py-2.5"} ${isGuestMode
                                ? "cursor-not-allowed opacity-50 border-zinc-200 bg-white text-zinc-400 dark:border-zinc-700/50 dark:bg-zinc-800/50 dark:text-zinc-500"
                                : isPrivateMode
                                    ? "cursor-pointer border-purple-700/70 bg-purple-950/40 text-purple-200 hover:bg-purple-900/50"
                                    : "cursor-pointer border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700/50 dark:bg-zinc-800/50 dark:text-zinc-300 dark:hover:bg-zinc-700/60 dark:hover:text-white"
                            }`}
                        title={isGuestMode ? t("sidebar.loginRequired") : ""}
                    >
                        {isPrivateMode ? t("sidebar.privateModeStop") : t("sidebar.privateModeStart")}
                        {isGuestMode && <Crown className="h-3.5 w-3.5" aria-hidden="true" />}
                    </button>
                    <FeatureHelpPopover
                        title={helpCopy.privateTitle}
                        description={helpCopy.privateDescription}
                        buttonLabel={helpCopy.helpAboutPrivate}
                        learnMoreLabel={helpCopy.learnMore}
                        topic="private"
                        href={chatWorkspaceGuideHref(lang, "files-and-drive")}
                        mobile={isMobileDrawer}
                        align="right"
                        testId="private-mode-help"
                    />
                </div>
            </div>

            <div className={`shrink-0 border-b border-zinc-200/60 px-3 dark:border-zinc-800/40 ${isMobileDrawer ? "py-2" : "py-3"}`}>
                <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                    <input
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder={t("sidebar.searchPlaceholder")}
                        className="h-9 w-full rounded-lg border border-zinc-200 bg-white pl-9 pr-3 text-xs text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-blue-500"
                    />
                </div>
                <div className="mt-2 rounded-xl border border-zinc-200 bg-white p-1.5 dark:border-zinc-800 dark:bg-zinc-950">
                    <button
                        type="button"
                        data-testid="sidebar-organizer-toggle"
                        aria-expanded={organizerExpanded}
                        aria-controls="sidebar-organizer-content"
                        onClick={toggleOrganizer}
                        className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-900"
                    >
                        <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-blue-500" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            <span className="block text-[11px] font-black text-zinc-700 dark:text-zinc-200">
                                {t("sidebar.organizerTools")}
                            </span>
                            {!organizerExpanded ? (
                                <span className="block truncate text-[10px] font-medium text-zinc-400">
                                    {activeOrganizerSummary}
                                </span>
                            ) : null}
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-bold text-zinc-500 dark:text-zinc-400">
                            {organizerExpanded
                                ? t("sidebar.organizerCollapse")
                                : t("sidebar.organizerExpand")}
                            <ChevronDown
                                className={`h-3.5 w-3.5 transition-transform ${organizerExpanded ? "rotate-180" : ""}`}
                                aria-hidden="true"
                            />
                        </span>
                    </button>
                    {organizerExpanded ? (
                        <div
                            id="sidebar-organizer-content"
                            data-testid="sidebar-organizer-content"
                            className="max-h-80 touch-pan-y overflow-y-auto overscroll-contain pr-0.5 [scrollbar-gutter:stable] [@media(max-height:860px)]:max-h-40"
                        >
                <div
                    data-testid="sidebar-status-filters"
                    className={`mt-2 rounded-xl border border-zinc-200 bg-white p-2 transition dark:border-zinc-800 dark:bg-zinc-950 ${
                        sidebarTourStep === 2 ? "ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-zinc-950" : ""
                    }`}
                >
                    <div className="flex items-center gap-1">
                        <span className="text-[10px] font-black uppercase tracking-wide text-zinc-500">
                            {helpCopy.statusTitle}
                        </span>
                        <FeatureHelpPopover
                            title={helpCopy.statusTitle}
                            description={helpCopy.statusDescription}
                            buttonLabel={helpCopy.helpAboutStatus}
                            learnMoreLabel={helpCopy.learnMore}
                            topic="locked"
                            href={chatWorkspaceGuideHref(lang, "states-and-labels")}
                            mobile={isMobileDrawer}
                            testId="status-help"
                        />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
                        {[
                            ["locked", helpCopy.lockedFilter],
                            ["shared", isMobileDrawer ? helpCopy.sharedBadge : helpCopy.sharedFilter],
                        ].map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() =>
                                    setConversationFilter((current) =>
                                        current === value ? "all" : (value as ConversationFilter)
                                    )
                                }
                                className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition-colors ${
                                    conversationFilter === value
                                        ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                                        : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                                }`}
                                aria-pressed={conversationFilter === value}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
                <div
                    data-testid="sidebar-label-filters"
                    className={`mt-2 rounded-xl border border-zinc-200 bg-white p-2 transition dark:border-zinc-800 dark:bg-zinc-950 ${
                        sidebarTourStep === 1 ? "ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-zinc-950" : ""
                    }`}
                >
                    <div className="flex items-center gap-1">
                        <span className="text-[10px] font-black uppercase tracking-wide text-zinc-500">
                            {helpCopy.labelsTitle}
                        </span>
                        <FeatureHelpPopover
                            title={helpCopy.labelsTitle}
                            description={helpCopy.labelsDescription}
                            buttonLabel={helpCopy.helpAboutLabels}
                            learnMoreLabel={helpCopy.learnMore}
                            topic="label"
                            href={chatWorkspaceGuideHref(lang, "labels")}
                            mobile={isMobileDrawer}
                            testId="labels-help"
                        />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
                        {[
                            ["work", t("sidebar.labelWork")],
                            ["research", t("sidebar.labelResearch")],
                            ["personal", t("sidebar.labelPersonal")],
                        ].map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() =>
                                    setConversationFilter((current) =>
                                        current === value ? "all" : (value as ConversationFilter)
                                    )
                                }
                                className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition-colors ${
                                    conversationFilter === value
                                        ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                                        : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                                }`}
                                aria-pressed={conversationFilter === value}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
                <div
                    data-testid="sidebar-projects"
                    className={`${isMobileDrawer ? "mt-2" : "mt-3"} rounded-xl border border-zinc-200 bg-white p-2 transition dark:border-zinc-800 dark:bg-zinc-950 ${
                        sidebarTourStep === 0 ? "ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-zinc-950" : ""
                    }`}
                >
                    <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-zinc-500">
                            <Folder className="h-3.5 w-3.5" />
                            {t("sidebar.projects")}
                            <FeatureHelpPopover
                                title={t("sidebar.projects")}
                                description={helpCopy.projectsDescription}
                                buttonLabel={helpCopy.helpAboutProjects}
                                learnMoreLabel={helpCopy.learnMore}
                                topic="project"
                                href={chatWorkspaceGuideHref(lang, "projects")}
                                mobile={isMobileDrawer}
                                testId="projects-help"
                            />
                        </span>
                        <button
                            type="button"
                            onClick={() => {
                                setShowProjectForm((value) => !value);
                                setProjectName("");
                            }}
                            className="inline-flex h-7 items-center gap-1 rounded-lg bg-zinc-100 px-2 text-[11px] font-bold text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                            <FolderPlus className="h-3.5 w-3.5" />
                            {t("sidebar.newProject")}
                        </button>
                    </div>
                    {showProjectForm && (
                        <form
                            className="mt-2 flex gap-1"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void createProject();
                            }}
                        >
                            <input
                                autoFocus
                                value={projectName}
                                onChange={(event) => setProjectName(event.target.value)}
                                maxLength={32}
                                placeholder={t("sidebar.projectNamePlaceholder")}
                                className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2 text-xs font-medium text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                            />
                            <button
                                type="button"
                                onClick={() => void createProject()}
                                disabled={!projectName.trim() || isCreatingProject}
                                className="h-8 rounded-lg bg-blue-600 px-2 text-[11px] font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {t("auth.ok")}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setShowProjectForm(false);
                                    setProjectName("");
                                }}
                                className="h-8 rounded-lg border border-zinc-200 px-2 text-[11px] font-black text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
                            >
                                {t("auth.cancel")}
                            </button>
                        </form>
                    )}
                    <div className="mt-2 space-y-1">
                        {projects.length === 0 ? (
                            <div className="rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-900">
                                <p className="text-[11px] font-medium leading-5 text-zinc-500 dark:text-zinc-400">
                                    {helpCopy.emptyProject}
                                </p>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowProjectForm(true);
                                        setProjectName("");
                                    }}
                                    className="mt-2 inline-flex items-center gap-1 text-[11px] font-black text-blue-600 hover:text-blue-500 dark:text-blue-300"
                                >
                                    <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                                    {helpCopy.createProject}
                                </button>
                            </div>
                        ) : (
                            projects.map((project) => {
                                const isEditingProject = editingProjectId === project.id;
                                const isDeleteArmed = deleteProjectArmedId === project.id;
                                const isProjectActive = conversationFilter === `project:${project.id}`;
                                return (
                                    <div
                                        key={project.id}
                                        className={`group flex items-center gap-1 rounded-lg px-1 py-1 transition-colors ${
                                            isProjectActive
                                                ? "bg-blue-600 text-white"
                                                : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                        }`}
                                    >
                                        {isEditingProject ? (
                                            <div
                                                className="flex min-w-0 flex-1 gap-1"
                                            >
                                                <input
                                                    autoFocus
                                                    value={editingProjectName}
                                                    onChange={(event) => setEditingProjectName(event.target.value)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                                                            event.preventDefault();
                                                            void renameProject(project.id);
                                                        }
                                                        if (event.key === "Escape") {
                                                            event.preventDefault();
                                                            setEditingProjectId(null);
                                                            setEditingProjectName("");
                                                        }
                                                    }}
                                                    maxLength={32}
                                                    className="h-7 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 text-[11px] font-bold text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => void renameProject(project.id)}
                                                    disabled={!editingProjectName.trim() || renamingProjectId === project.id}
                                                    className="h-7 rounded-md bg-blue-500 px-2 text-[10px] font-black text-white"
                                                >
                                                    {t("auth.ok")}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setEditingProjectId(null);
                                                        setEditingProjectName("");
                                                    }}
                                                    className="h-7 rounded-md px-2 text-[10px] font-black text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                                                >
                                                    {t("auth.cancel")}
                                                </button>
                                            </div>
                                        ) : (
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setConversationFilter((current) =>
                                                            current === `project:${project.id}`
                                                                ? "all"
                                                                : `project:${project.id}`
                                                        )
                                                    }
                                                    className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left"
                                                    aria-pressed={isProjectActive}
                                                >
                                                    <span className="truncate text-[11px] font-black">{project.name}</span>
                                                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-black ${
                                                        isProjectActive
                                                            ? "bg-white/15 text-white"
                                                            : "bg-white text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300"
                                                    }`}>
                                                        {project.conversationCount ?? 0}
                                                    </span>
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => startProjectRename(project)}
                                                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                                                        isProjectActive
                                                            ? "text-white/80 hover:bg-white/10"
                                                            : "text-zinc-400 hover:bg-white hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                                                    }`}
                                                    aria-label={t("sidebar.renameProject")}
                                                >
                                                    <Pencil className="h-3.5 w-3.5" />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void deleteProject(project.id)}
                                                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                                                        isDeleteArmed
                                                            ? "bg-red-500 text-white"
                                                            : isProjectActive
                                                                ? "text-white/80 hover:bg-white/10"
                                                                : "text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                                                    }`}
                                                    aria-label={t("sidebar.deleteProject")}
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
                        </div>
                    ) : null}
                </div>
            </div>

            <div
                data-testid="sidebar-conversation-list"
                className="min-h-[10rem] flex-1 touch-pan-y space-y-1 overflow-y-auto overscroll-contain p-2 [scrollbar-gutter:stable]"
            >
                {messageSearchResults.length > 0 && (
                    <div className="mb-2 rounded-xl border border-blue-200 bg-blue-50 p-2 text-xs dark:border-blue-900/50 dark:bg-blue-950/20">
                        <p className="px-1 pb-1 font-black text-blue-700 dark:text-blue-300">
                            {t("sidebar.messageMatches")}
                        </p>
                        {messageSearchResults.slice(0, 4).map((result) => (
                            <button
                                key={result.id}
                                type="button"
                                onClick={() => onSelectConversation(result.conversationId)}
                                className="block w-full rounded-lg px-2 py-1.5 text-left text-zinc-600 hover:bg-white dark:text-zinc-300 dark:hover:bg-zinc-900"
                            >
                                <span className="block truncate font-bold">{result.conversationTitle}</span>
                                <span className="block truncate text-[11px] text-zinc-400">{result.snippet}</span>
                            </button>
                        ))}
                    </div>
                )}
                {filteredConversations.length === 0 && (
                    <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 px-4 py-4 text-center text-xs text-zinc-400 dark:border-zinc-800">
                        <MessageSquare className="mb-2 h-5 w-5" />
                        {activeLabelFilter && !normalizedSearch ? (
                            <>
                                <p className="font-bold text-zinc-600 dark:text-zinc-300">
                                    {helpCopy.emptyLabels[activeLabelFilter]}
                                </p>
                                <p className="mt-1 leading-5">{helpCopy.emptyLabelBody}</p>
                                <Link
                                    href={chatWorkspaceGuideHref(lang, "labels")}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-2 font-black text-blue-600 hover:text-blue-500 dark:text-blue-300"
                                >
                                    {helpCopy.labelGuide}
                                </Link>
                            </>
                        ) : (
                            t("sidebar.noConversations")
                        )}
                    </div>
                )}
                {filteredConversations.map((conv) => {
                    const isActive = currentChatId === conv.id;
                    const isPrivate = conv.id === "private-chat";
                    const isMenuOpen = openMenuId === conv.id;

                    return (
                        <div
                            key={conv.id}
                            onClick={() => onSelectConversation(conv.id)}
                            className={`relative group flex items-center justify-between rounded-xl px-3 py-2.5 text-xs cursor-pointer transition-all border ${isMenuOpen ? "z-20" : "z-10"} ${isPrivate
                                    ? isActive
                                    ? "bg-purple-100 border-purple-300 text-purple-700 font-semibold dark:bg-purple-900/30 dark:border-purple-700/60 dark:text-purple-200"
                                    : "bg-purple-50/50 border-purple-100 text-purple-500 hover:bg-purple-100 dark:bg-purple-950/15 dark:border-purple-900/20 dark:text-purple-400/80 dark:hover:bg-purple-900/20 dark:hover:text-purple-300"
                                : isActive
                                    ? "bg-zinc-200 border-zinc-300 text-zinc-900 font-semibold dark:bg-zinc-800 dark:border-zinc-700/80 dark:text-zinc-100"
                                    : "bg-transparent border-transparent text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200"
                                }`}
                            title={isGuestMode ? t("sidebar.loginRequired") : ""}
                        >
                            <div className="cursor-pointer flex min-w-0 flex-1 items-center gap-2.5 pr-6">
                                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isPrivate ? "bg-purple-500/10 text-purple-500" : conv.isLocked ? "bg-amber-500/10 text-amber-500" : "bg-blue-500/10 text-blue-500"}`}>
                                    {isPrivate || conv.isLocked ? (
                                        <Lock className="h-3.5 w-3.5" />
                                    ) : (
                                        <MessageSquare className="h-3.5 w-3.5" />
                                    )}
                                </span>
                                <span className="min-w-0 flex flex-col gap-1">
                                    <span className="truncate text-[13px] leading-4">{conv.title}</span>
                                    {conversationLabels[conv.id] && (
                                        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-bold text-blue-500">
                                            <Tag className="h-2.5 w-2.5" />
                                            {labelText(conversationLabels[conv.id])}
                                        </span>
                                    )}
                                    {getConversationProjectId(conv) && (
                                        <span className="inline-flex w-fit max-w-full items-center gap-1 rounded-full bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-bold text-purple-500">
                                            <Folder className="h-2.5 w-2.5 shrink-0" />
                                            <span className="truncate">{projectText(getConversationProjectId(conv) || "")}</span>
                                        </span>
                                    )}
                                    <span className="flex items-center gap-1.5 truncate text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                                        {pinnedConversationIds.includes(conv.id) && <Pin className="h-3 w-3 shrink-0 text-blue-500" />}
                                        {favoriteConversationIds.includes(conv.id) && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                                        <Sparkles className="h-3 w-3 shrink-0" />
                                        <span className="truncate">{getConversationModelSummary(conv)}</span>
                                        {conv.shareEnabled && (
                                            <span className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-bold text-blue-500">
                                                {helpCopy.sharedBadge}
                                            </span>
                                        )}
                                        {conv.isLocked && (
                                            <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-500">
                                                {helpCopy.lockedBadge}
                                            </span>
                                        )}
                                    </span>
                                </span>
                            </div>

                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center context-menu-wrapper">
                                <button
                                    type="button"
                                    data-testid="conversation-menu"
                                    data-conversation-id={conv.id}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenMenuId(openMenuId === conv.id ? null : conv.id);
                                    }}
                                    className="cursor-pointer p-1 text-zinc-500 hover:text-zinc-200 transition-colors"
                                    title={t("chat.moreActions")}
                                    aria-label={`${t("chat.moreActions")}: ${conv.title}`}
                                >
                                    <MoreVertical className="h-4 w-4" />
                                </button>

                                {isMenuOpen && (
                                    <div
                                        data-testid="conversation-menu-panel"
                                        className="absolute right-0 top-6 z-50 w-56 rounded-lg border border-zinc-800 bg-zinc-900 p-1.5 shadow-xl flex flex-col text-xs text-zinc-300 animate-fadeIn"
                                    >
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setOpenMenuId(null);
                                                setRenameTarget(conv);
                                                setRenameValue(conv.title);
                                            }}
                                            className={`${menuItemBase} ${menuItemEnabled}`}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Pencil className={menuIconClass} />
                                                <span>{t("sidebar.rename")}</span>
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                togglePinned(conv.id);
                                                setOpenMenuId(null);
                                            }}
                                            className={`${menuItemBase} ${menuItemEnabled}`}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Pin className={menuIconClass} />
                                                <span>{pinnedConversationIds.includes(conv.id) ? t("sidebar.unpinChat") : t("sidebar.pinChat")}</span>
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                toggleFavorite(conv.id);
                                                setOpenMenuId(null);
                                            }}
                                            className={`${menuItemBase} ${menuItemEnabled}`}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Star className={menuIconClass} />
                                                <span>{favoriteConversationIds.includes(conv.id) ? t("sidebar.removeFavorite") : t("sidebar.favoriteChat")}</span>
                                            </span>
                                        </button>

                                        <div className="my-1 border-t border-zinc-800" />
                                        <div className="px-3 py-1 text-[10px] font-black uppercase tracking-wide text-zinc-500">
                                            {helpCopy.labelAssignment}
                                        </div>
                                        {(["work", "research", "personal"] as const).map((label) => (
                                            <button
                                                key={label}
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setConversationLabel(
                                                        conv.id,
                                                        conversationLabels[conv.id] === label ? null : label
                                                    );
                                                    setOpenMenuId(null);
                                                }}
                                                className={`${menuItemBase} ${menuItemEnabled}`}
                                            >
                                                <span className="flex items-center gap-2">
                                                    {conversationLabels[conv.id] === label ? (
                                                        <Check className={`${menuIconClass} text-blue-400`} />
                                                    ) : (
                                                        <Tag className={menuIconClass} />
                                                    )}
                                                    <span>{labelText(label)}</span>
                                                </span>
                                            </button>
                                        ))}
                                        <div className="my-1 border-t border-zinc-800" />
                                        <div className="px-3 py-1 text-[10px] font-black uppercase tracking-wide text-zinc-500">
                                            {t("sidebar.moveToProject")}
                                        </div>
                                        {projects.length === 0 ? (
                                            <div className="px-3 py-2 text-xs text-zinc-500">
                                                {t("sidebar.noProjects")}
                                            </div>
                                        ) : (
                                            <>
                                                {projects.slice(0, 6).map((project) => (
                                                    <button
                                                        key={project.id}
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            void setConversationProject(
                                                                conv.id,
                                                                getConversationProjectId(conv) === project.id ? null : project.id
                                                            );
                                                            setOpenMenuId(null);
                                                        }}
                                                        className={`${menuItemBase} ${menuItemEnabled}`}
                                                    >
                                                        <span className="flex min-w-0 items-center gap-2">
                                                            <Folder className={menuIconClass} />
                                                            <span className="truncate">{project.name}</span>
                                                        </span>
                                                    </button>
                                                ))}
                                                {getConversationProjectId(conv) && (
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            void setConversationProject(conv.id, null);
                                                            setOpenMenuId(null);
                                                        }}
                                                        className={`${menuItemBase} ${menuItemEnabled}`}
                                                    >
                                                        <span className="flex items-center gap-2">
                                                            <X className={menuIconClass} />
                                                            <span>{t("sidebar.removeProject")}</span>
                                                        </span>
                                                    </button>
                                                )}
                                            </>
                                        )}

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (canShare) {
                                                    setShareTarget(conv);
                                                    setOpenMenuId(null);
                                                    trackProductEvent("ui_help_opened", 0, {
                                                        help_topic: "shared",
                                                    });
                                                }
                                            }}
                                            disabled={!canShare}
                                            className={`${menuItemBase} ${!canShare ? menuItemDisabled : menuItemEnabled}`}
                                            title={isGuestMode ? t("sidebar.loginRequired") : !canShare ? t("modelStatusReasons.upgradeRequired") : ""}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Share2 className={menuIconClass} />
                                                <span>
                                                    {conv.shareEnabled
                                                        ? t("sidebar.refreshShare")
                                                        : t("sidebar.share")}
                                                </span>
                                            </span>
                                            {!canShare && <Crown className={crownClass} />}
                                        </button>

                                        {conv.shareEnabled && !isGuestMode && (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setOpenMenuId(null);
                                                    onRevokeShare(conv.id);
                                                }}
                                                className={`${menuItemBase} ${menuItemEnabled}`}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Link2Off className={menuIconClass} />
                                                    <span>{t("sidebar.revokeShare")}</span>
                                                </span>
                                            </button>
                                        )}

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (canDownload) {
                                                    onDownload(conv.id, conv.title);
                                                    setOpenMenuId(null);
                                                }
                                            }}
                                            disabled={!canDownload}
                                            className={`${menuItemBase} ${!canDownload ? menuItemDisabled : menuItemEnabled}`}
                                            title={isGuestMode ? t("sidebar.loginRequired") : !canDownload ? t("modelStatusReasons.upgradeRequired") : ""}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Download className={menuIconClass} />
                                                <span>{t("sidebar.downloadTxt")}</span>
                                            </span>
                                            {!canDownload && <Crown className={crownClass} />}
                                        </button>


                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setOpenMenuId(null);
                                                onDelete(conv.id);
                                            }}
                                            className={`${menuItemBase} cursor-pointer text-red-400 hover:bg-zinc-800 hover:text-red-300`}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Trash2 className={menuIconClass} />
                                                <span>{t("sidebar.delete")}</span>
                                            </span>
                                        </button>

                                        {isGuestMode ? (
                                            <button
                                                type="button"
                                                disabled
                                                className={`${menuItemBase} ${menuItemDisabled}`}
                                                title={t("sidebar.loginRequired")}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Lock className={menuIconClass} />
                                                    <span>{t("sidebar.lock")}</span>
                                                </span>
                                                <Crown className={crownClass} />
                                            </button>
                                        ) : conv.isLocked ? (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setOpenMenuId(null);
                                                    if (onUnlock) onUnlock(conv.id);
                                                }}
                                                className={`${menuItemBase} ${menuItemEnabled}`}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Unlock className={menuIconClass} />
                                                    <span>{t("sidebar.unlock")}</span>
                                                </span>
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setOpenMenuId(null);
                                                    setLockTarget(conv);
                                                    setLockPassword("");
                                                    setLockError("");
                                                    trackProductEvent("ui_help_opened", 0, {
                                                        help_topic: "locked",
                                                    });
                                                }}
                                                className={`${menuItemBase} ${menuItemEnabled}`}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Lock className={menuIconClass} />
                                                    <span>{t("sidebar.lock")}</span>
                                                </span>
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className={`${isMobileDrawer ? "shrink-0 border-t border-zinc-200 bg-zinc-100/40 p-2 dark:border-zinc-800 dark:bg-zinc-900/50" : "shrink-0 border-t border-zinc-200 bg-zinc-100/40 p-3 dark:border-zinc-800 dark:bg-zinc-900/50"} flex min-h-0 flex-col gap-2 overflow-visible`}>
                <div className="shrink-0">
                    <UserUsageSummary
                        isGuestMode={isGuestMode}
                        guestMessageCount={guestMessageCount}
                        maxGuestMessages={maxGuestMessages}
                        usageOverride={isGuestMode ? undefined : accountUsage}
                        compact
                        headerAction={
                            <FeatureHelpPopover
                                title={helpCopy.creditsTitle}
                                description={helpCopy.creditsDescription}
                                buttonLabel={helpCopy.helpAboutCredits}
                                learnMoreLabel={helpCopy.learnMore}
                                topic="credits"
                                href={chatWorkspaceGuideHref(lang, "credits-and-plans")}
                                mobile={isMobileDrawer}
                                testId="credits-help"
                            />
                        }
                    />
                </div>
                <div className="shrink-0" data-testid="sidebar-account-controls">
                    <AuthButton />
                </div>
                <div className="shrink-0">
                    <FeedbackButton
                        currentModelId={currentModelId}
                        currentPlan={displayedPlan}
                        attachmentCount={attachmentCount}
                    />
                </div>
            </div>
            {sidebarTourStep !== null ? (
                <div
                    data-testid="sidebar-tour"
                    className="absolute inset-x-3 bottom-3 z-[80] rounded-2xl border border-blue-300 bg-white p-4 shadow-2xl dark:border-blue-800 dark:bg-zinc-900"
                    role="dialog"
                    aria-label={helpCopy.tourSteps[sidebarTourStep].title}
                    aria-live="polite"
                >
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[10px] font-black uppercase tracking-[0.16em] text-blue-600 dark:text-blue-300">
                            {sidebarTourStep + 1} / {helpCopy.tourSteps.length}
                        </span>
                        <button
                            type="button"
                            data-testid="sidebar-tour-skip"
                            onClick={skipSidebarTour}
                            className="text-[11px] font-bold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                        >
                            {helpCopy.tourSkip}
                        </button>
                    </div>
                    <h2 className="mt-2 text-sm font-black text-zinc-950 dark:text-white">
                        {helpCopy.tourSteps[sidebarTourStep].title}
                    </h2>
                    <p className="mt-1 text-xs font-medium leading-5 text-zinc-600 dark:text-zinc-300">
                        {helpCopy.tourSteps[sidebarTourStep].body}
                    </p>
                    <button
                        type="button"
                        data-testid="sidebar-tour-next"
                        onClick={advanceSidebarTour}
                        className="mt-3 flex h-9 w-full items-center justify-center rounded-xl bg-blue-600 px-4 text-xs font-black text-white hover:bg-blue-500"
                    >
                        {sidebarTourStep === helpCopy.tourSteps.length - 1
                            ? helpCopy.tourDone
                            : helpCopy.tourNext}
                    </button>
                </div>
            ) : null}
        </aside>
        {showPrivateNotice && (
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
                role="presentation"
                onMouseDown={(event) => {
                    if (event.target === event.currentTarget) {
                        closePrivateNotice(true);
                    }
                }}
            >
                <div
                    ref={privateNoticeDialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="private-mode-notice-title"
                    className="w-full max-w-lg rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
                >
                    <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
                        <div className="flex min-w-0 items-center gap-3">
                            <ShieldCheck className="h-5 w-5 shrink-0 text-purple-500" />
                            <div>
                                <h2
                                    id="private-mode-notice-title"
                                    className="text-base font-semibold text-zinc-900 dark:text-zinc-100"
                                >
                                    {t("sidebar.privateNoticeTitle")}
                                </h2>
                                <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                                    {t("sidebar.privateNoticeIntro")}
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => closePrivateNotice(true)}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                            aria-label={t("auth.cancel")}
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    <div className="space-y-4 px-5 py-4 text-sm text-zinc-700 dark:text-zinc-300">
                        <div className="flex gap-3">
                            <Database className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                            <p className="leading-6">{t("sidebar.privateNoticeNoSave")}</p>
                        </div>
                        <div className="flex gap-3">
                            <Send className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
                            <p className="leading-6">{t("sidebar.privateNoticeProvider")}</p>
                        </div>
                        <div className="flex gap-3">
                            <CloudUpload className="mt-0.5 h-4 w-4 shrink-0 text-cyan-500" />
                            <p className="leading-6">{t("sidebar.privateNoticeAttachment")}</p>
                        </div>
                        <div className="flex gap-3 rounded-md bg-amber-50 px-3 py-2.5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <p className="text-xs leading-5">{t("sidebar.privateNoticeCaution")}</p>
                        </div>
                        <Link
                            href="/privacy"
                            className="inline-flex text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                            {t("sidebar.privateNoticePolicy")}
                        </Link>
                    </div>

                    <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
                        <button
                            type="button"
                            onClick={() => closePrivateNotice(true)}
                            className="rounded-md px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                            {t("auth.cancel")}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                closePrivateNotice(false);
                                onTogglePrivateMode();
                            }}
                            className="rounded-md bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-500"
                        >
                            {t("sidebar.privateNoticeContinue")}
                        </button>
                    </div>
                </div>
            </div>
        )}
        {renameTarget && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        const nextTitle = renameValue.trim();
                        if (!nextTitle) return;
                        onRename(renameTarget.id, nextTitle);
                        setRenameTarget(null);
                    }}
                    className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
                >
                    <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                        {t("sidebar.rename")}
                    </h2>
                    <label className="mt-4 block text-xs font-semibold text-zinc-500">
                        {t("sidebar.chatTitle")}
                    </label>
                    <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        maxLength={80}
                        className="mt-2 h-11 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-sm font-medium text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                    <div className="mt-5 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setRenameTarget(null)}
                            className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                            {t("auth.cancel")}
                        </button>
                        <button
                            type="submit"
                            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
                        >
                            {t("auth.ok")}
                        </button>
                    </div>
                </form>
            </div>
        )}
        {shareTarget && (
            <div
                className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
                role="presentation"
                onMouseDown={(event) => {
                    if (event.target === event.currentTarget) setShareTarget(null);
                }}
            >
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="conversation-share-title"
                    data-testid="share-confirmation-dialog"
                    className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
                >
                    <div className="flex items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
                            <Share2 className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <div>
                            <h2 id="conversation-share-title" className="text-base font-black text-zinc-950 dark:text-white">
                                {helpCopy.shareDialogTitle}
                            </h2>
                            <p className="mt-1 text-xs font-semibold text-zinc-500">{shareTarget.title}</p>
                        </div>
                    </div>
                    <div className="mt-5 space-y-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                        <p>{helpCopy.shareDialogBody}</p>
                        <p className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs font-semibold text-blue-950 dark:border-blue-900/70 dark:bg-blue-950/30 dark:text-blue-100">
                            {helpCopy.shareDialogSnapshot}
                        </p>
                        <p className="flex gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            {helpCopy.shareDialogVisibility}
                        </p>
                    </div>
                    <div className="mt-5 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setShareTarget(null)}
                            className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                            {t("auth.cancel")}
                        </button>
                        <button
                            type="button"
                            data-testid="share-confirmation-submit"
                            onClick={() => {
                                onShare(shareTarget.id, shareTarget.title);
                                setShareTarget(null);
                            }}
                            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-black text-white hover:bg-blue-500"
                        >
                            {shareTarget.shareEnabled
                                ? t("sidebar.refreshShare")
                                : helpCopy.shareDialogConfirm}
                        </button>
                    </div>
                </div>
            </div>
        )}
        {lockTarget && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                <form
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="conversation-lock-title"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const password = lockPassword.trim();
                        if (password.length < 8 || password.length > 128) {
                            setLockError(t("sidebar.passwordLength"));
                            return;
                        }
                        if (onLock) onLock(lockTarget.id, password);
                        setLockTarget(null);
                    }}
                    className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
                >
                    <h2
                        id="conversation-lock-title"
                        className="text-base font-bold text-zinc-900 dark:text-zinc-100"
                    >
                        {t("sidebar.lock")}
                    </h2>
                    <p className="mt-2 text-sm text-zinc-500">{lockTarget.title}</p>
                    <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-semibold leading-5 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                        {helpCopy.lockDescription}
                    </p>
                    <label
                        htmlFor="conversation-lock-password"
                        className="mt-4 block text-xs font-semibold text-zinc-500"
                    >
                        {t("sidebar.password")}
                    </label>
                    <input
                        id="conversation-lock-password"
                        autoFocus
                        type="password"
                        value={lockPassword}
                        onChange={(event) => {
                            setLockPassword(event.target.value);
                            setLockError("");
                        }}
                        className="mt-2 h-11 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-sm font-medium text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                    {lockError && <p className="mt-2 text-xs font-medium text-red-500">{lockError}</p>}
                    <div className="mt-5 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setLockTarget(null)}
                            className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                            {t("auth.cancel")}
                        </button>
                        <button
                            type="submit"
                            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
                        >
                            {t("auth.ok")}
                        </button>
                    </div>
                </form>
            </div>
        )}
        </>
    );
}
