import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import VirtualizedVideoGrid from "../components/VirtualizedVideoGrid";
import SearchBar from "../components/SearchBar";
import { useGlowEffect } from "../hooks/useGlowEffect";
import LightRays from "../components/LightRays";
import { VideoFile, VideoFileWithMetadata, SortBy, SortOrder } from "../types";
import "../styles/LibraryView.css";
import "../styles/GlowWrapper.css";
import WindowControls from "../components/WindowControls";
import LogoUrl from "../../assets/VCMLogo.svg";

const api = window.api;
const path = window.path;
const os = window.os;

const LibraryView: React.FC = () => {
  const navigate = useNavigate();
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [videos, setVideos] = useState<VideoFileWithMetadata[]>([]);
  const [filteredVideos, setFilteredVideos] = useState<VideoFileWithMetadata[]>(
    []
  );
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [appVersion, setAppVersion] = useState<string>("v1.0.0");
  const [sortBy, setSortBy] = useState<SortBy>(() => {
    const saved = localStorage.getItem("sortBy");
    return (saved as SortBy) || "date";
  });
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => {
    const saved = localStorage.getItem("sortOrder");
    return (saved as SortOrder) || "desc";
  });
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(() => {
    const saved = localStorage.getItem("showFavoritesOnly");
    return saved === "true";
  });
  const [groupByFolder, setGroupByFolder] = useState(() => {
    const saved = localStorage.getItem("groupByFolder");
    return saved === "true";
  });
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(new Set());
  const hasLoadedRef = React.useRef(false);

  // Initialize glow effect system
  useGlowEffect();

  // Load app version on mount
  useEffect(() => {
    const version = api.getVersion();
    setAppVersion(`v${version}`);
  }, []);

  // Load last folder on mount (only if not already loaded)
  useEffect(() => {
    const lastFolder = localStorage.getItem("lastFolderPath");
    if (lastFolder && !hasLoadedRef.current) {
      setFolderPath(lastFolder);
      loadVideos(lastFolder);
      hasLoadedRef.current = true;
    }
  }, []);

  // Listen for file system changes
  useEffect(() => {
    if (!folderPath) return;

    const handleFileAdded = (data?: { filePath: string }) => {
      if (!data?.filePath) return;
      addNewVideo(data.filePath);
    };

    const handleFileRemoved = (data?: { filePath: string }) => {
      if (!data?.filePath) return;
      removeVideo(data.filePath);
    };

    const unsubFileAdded = api.on("file-added", handleFileAdded);
    const unsubFileRemoved = api.on("file-removed", handleFileRemoved);

    // Start watching this folder
    api.watchFolder(folderPath).then(() => {});

    return () => {
      if (unsubFileAdded) unsubFileAdded();
      if (unsubFileRemoved) unsubFileRemoved();
      // Stop watching when component unmounts or folder changes
      api.unwatchFolder(folderPath);
    };
  }, [folderPath]);

  // Save filter and sorting preferences to localStorage
  useEffect(() => {
    localStorage.setItem("showFavoritesOnly", String(showFavoritesOnly));
  }, [showFavoritesOnly]);

  useEffect(() => {
    localStorage.setItem("groupByFolder", String(groupByFolder));
  }, [groupByFolder]);

  useEffect(() => {
    localStorage.setItem("sortBy", sortBy);
  }, [sortBy]);

  useEffect(() => {
    localStorage.setItem("sortOrder", sortOrder);
  }, [sortOrder]);

  const handleSelectFolder = async () => {
    const selected = await api.selectFolder();
    if (selected) {
      setFolderPath(selected);
      localStorage.setItem("lastFolderPath", selected);
      loadVideos(selected);
    }
  };

  const loadVideos = async (folder: string) => {
    setLoading(true);
    try {
      const scannedVideos = await api.scanVideos(folder);

      // Show videos immediately with placeholder data
      const initialVideos: VideoFileWithMetadata[] = scannedVideos.map(
        (video: VideoFile) => ({
          ...video,
          duration: 0,
          thumbnail: "",
          isFavorite: false,
        })
      );

      setVideos(initialVideos);
      setFilteredVideos(initialVideos);
      setLoading(false); // Hide loading screen immediately

      // Fetch metadata, content hash, and favorite status progressively
      const concurrency = 8; // Increased for faster loading
      const result: VideoFileWithMetadata[] = [...initialVideos];
      let index = 0;
      let lastUpdateTime = 0;
      const updateInterval = 500; // Update at most every 500ms
      let pendingUpdate = false;

      const scheduleUpdate = () => {
        if (pendingUpdate) return;
        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateTime;

        if (timeSinceLastUpdate >= updateInterval) {
          // Update immediately
          setVideos([...result]);
          lastUpdateTime = now;
        } else {
          // Schedule update for later
          pendingUpdate = true;
          setTimeout(() => {
            setVideos([...result]);
            lastUpdateTime = Date.now();
            pendingUpdate = false;
          }, updateInterval - timeSinceLastUpdate);
        }
      };

      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (index < scannedVideos.length) {
            const currentIndex = index++;
            const current = scannedVideos[currentIndex];
            try {
              // Get metadata
              const metadata = await api.getCachedMetadata(current.path);
              const duration = metadata?.format?.duration || 0;

              // Get content hash and favorite status (even for corrupted files)
              // IMPORTANT: Pass duration to ensure consistent hash generation
              const contentHash = await api.getClipHash(current.path, duration);
              const isFavorite = await api.isFavorite(contentHash);

              // Get saved edits
              const edits = await api.getClipEdits(contentHash);

              const enrichedVideo: VideoFileWithMetadata = {
                ...current,
                duration,
                thumbnail: "",
                contentHash,
                isFavorite,
                edits,
              };

              result[currentIndex] = enrichedVideo;

              // Schedule time-based batch update instead of count-based
              scheduleUpdate();
            } catch (error) {
              console.error("Error loading video data:", error);
              // Add video with placeholder data so user can see it exists
              result[currentIndex] = {
                ...current,
                duration: 0,
                thumbnail: "",
                isFavorite: false,
              };
            }
          }
        })
      );

      // Final update to ensure all data is set
      setVideos(result);
    } catch (error) {
      console.error("Error loading videos:", error);
      setLoading(false);
    }
  };

  const addNewVideo = async (filePath: string) => {
    try {
      const stats = await api.getFileStats(filePath);
      if (!stats) {
        return;
      }

      // Get metadata
      const metadata = await api.getCachedMetadata(filePath);
      const duration = metadata?.format?.duration || 0;

      // Get content hash and favorite status
      // IMPORTANT: Pass duration to ensure consistent hash generation
      const contentHash = await api.getClipHash(filePath, duration);
      const isFavorite = await api.isFavorite(contentHash);

      // Get saved edits
      const edits = await api.getClipEdits(contentHash);

      const newVideo: VideoFileWithMetadata = {
        name: stats.name,
        path: filePath,
        size: stats.size,
        created: stats.created,
        modified: stats.modified,
        duration,
        thumbnail: "",
        contentHash,
        isFavorite,
        edits,
        relativePath: stats.relativePath,
        folderPath: stats.folderPath,
      };

      setVideos((prev) => [...prev, newVideo]);
    } catch (error) {
      console.error("[LibraryView] Error adding new video:", error);
    }
  };

  const removeVideo = (filePath: string) => {
    setVideos((prev) => prev.filter((v) => v.path !== filePath));
  };

  useEffect(() => {
    let result = [...videos];

    // Filter by favorites
    if (showFavoritesOnly) {
      result = result.filter((video) => video.isFavorite);
    }

    // Filter by search query
    if (searchQuery) {
      result = result.filter((video) =>
        video.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case "name":
          comparison = a.name.localeCompare(b.name);
          break;
        case "date":
          comparison =
            new Date(a.created).getTime() - new Date(b.created).getTime();
          break;
        case "size":
          comparison = a.size - b.size;
          break;
      }

      return sortOrder === "asc" ? comparison : -comparison;
    });

    setFilteredVideos(result);
  }, [searchQuery, sortBy, sortOrder, videos, showFavoritesOnly]);

  const handleVideoSelect = React.useCallback(
    (video: VideoFile) => {
      // Show black overlay and hide light rays immediately
      if ((window as any).__showOverlay) {
        (window as any).__showOverlay();
      }

      // Navigate immediately
      navigate("/editor", { state: { video } });
    },
    [navigate]
  );

  const handleToggleFavorite = React.useCallback(
    async (video: VideoFileWithMetadata) => {
      if (!video.contentHash) return;

      try {
        const result = await api.toggleFavorite({
          contentHash: video.contentHash,
          filepath: video.path,
          fileSize: video.size,
          duration: video.duration || null,
        });

        // Update videos state - filteredVideos will be updated by the useEffect
        setVideos((prevVideos) =>
          prevVideos.map((v) =>
            v.path === video.path ? { ...v, isFavorite: result.isFavorite } : v
          )
        );
      } catch (error) {
        console.error("Error toggling favorite:", error);
      }
    },
    []
  );

  const handleToggleSelect = React.useCallback((videoPath: string) => {
    setSelectedVideos((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(videoPath)) {
        newSet.delete(videoPath);
      } else {
        newSet.add(videoPath);
      }
      return newSet;
    });
  }, []);

  const handleSelectAll = () => {
    const allPaths = new Set(filteredVideos.map((v) => v.path));
    setSelectedVideos(allPaths);
  };

  const handleDeselectAll = () => {
    setSelectedVideos(new Set());
  };

  const handleTrashSelected = async () => {
    if (selectedVideos.size === 0) return;

    const confirmed = confirm(
      `Are you sure you want to move ${selectedVideos.size} clip(s) to trash?`
    );
    if (!confirmed) return;

    try {
      const paths = Array.from(selectedVideos);
      await api.trashFiles(paths);

      // Remove from videos state
      setVideos((prev) => prev.filter((v) => !selectedVideos.has(v.path)));
      setSelectedVideos(new Set());
    } catch (error) {
      console.error("Error trashing files:", error);
      alert("Failed to move files to trash. See console for details.");
    }
  };

  const handleFavoriteSelected = async () => {
    if (selectedVideos.size === 0) return;

    try {
      const selectedVideoObjects = videos.filter((v) =>
        selectedVideos.has(v.path)
      );

      // Check if all selected videos are already favorited
      const allFavorited = selectedVideoObjects.every(
        (video) => video.isFavorite
      );

      // If all are favorited, unfavorite all; otherwise, favorite all
      const targetFavoriteState = !allFavorited;

      for (const video of selectedVideoObjects) {
        if (!video.contentHash) continue;

        // Only toggle if the current state differs from target state
        if (video.isFavorite !== targetFavoriteState) {
          await api.toggleFavorite({
            contentHash: video.contentHash,
            filepath: video.path,
            fileSize: video.size,
            duration: video.duration || null,
          });
        }
      }

      // Update local state
      setVideos((prevVideos) =>
        prevVideos.map((v) =>
          selectedVideos.has(v.path)
            ? { ...v, isFavorite: targetFavoriteState }
            : v
        )
      );

      setSelectedVideos(new Set());
    } catch (error) {
      console.error("Error toggling favorite selected:", error);
      alert("Failed to toggle favorite status. See console for details.");
    }
  };

  // Group videos by folder
  const groupedVideos = () => {
    const groups = new Map<string, VideoFileWithMetadata[]>();

    filteredVideos.forEach((video) => {
      const folder = video.folderPath || "Root";
      if (!groups.has(folder)) {
        groups.set(folder, []);
      }
      groups.get(folder)!.push(video);
    });

    // Convert to array and sort by folder name
    return Array.from(groups.entries())
      .map(([folder, videos]) => ({ folder, videos }))
      .sort((a, b) => {
        // Root folder always first
        if (a.folder === "Root") return -1;
        if (b.folder === "Root") return 1;
        return a.folder.localeCompare(b.folder);
      });
  };

  const scrollParentRef = React.useRef<HTMLDivElement | null>(null);

  return (
    <div className="library-view">
      <header className="library-header">
        <div className="logo-container">
          <img
            className="app-logo no-drag"
            src={LogoUrl}
            alt=""
            width="48"
            height="48"
          />
          <h1 className="app-title">
            <span className="title">V.C.M</span>
            <span className="version">{appVersion}</span>
          </h1>
        </div>
        <div className="library-header-actions">
          <button
            className="btn folder-select-btn no-drag"
            onClick={handleSelectFolder}
            data-glow
          >
            {folderPath ? "Change Folder" : "Select Folder"}
          </button>
          <WindowControls />
        </div>
      </header>

      <div
        className={`library-content ${
          selectedVideos.size > 0 ? "has-selection-bar" : ""
        }`}
        ref={scrollParentRef}
      >
        <LightRays
          raysOrigin="top-center"
          raysColor="#ffffff"
          raysSpeed={1.5}
          lightSpread={0.8}
          rayLength={1.2}
          followMouse={true}
          mouseInfluence={0.1}
          noiseAmount={0.25}
          distortion={0.05}
          className="custom-rays"
        />
        <div className="library-controls">
          <SearchBar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            sortBy={sortBy}
            onSortByChange={setSortBy}
            sortOrder={sortOrder}
            onSortOrderChange={setSortOrder}
          />
          <div className="filter-toggles">
            <button
              className={`btn filter-toggle-btn ${
                showFavoritesOnly ? "active" : ""
              }`}
              data-glow
              onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
              title="Show favorites only"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill={showFavoritesOnly ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              Favorites Only
            </button>
            <button
              className={`btn filter-toggle-btn ${
                groupByFolder ? "active" : ""
              }`}
              data-glow
              onClick={() => setGroupByFolder(!groupByFolder)}
              title="Group clips by folder"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill={groupByFolder ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              </svg>
              Group by Folder
            </button>
          </div>
        </div>
        {loading ? (
          <div className="loading-state">
            <div className="spinner"></div>
            <p>Loading videos...</p>
          </div>
        ) : folderPath ? (
          groupByFolder ? (
            <div className="grouped-videos">
              {groupedVideos().map((group) => (
                <div key={group.folder} className="video-group">
                  <h3 className="group-header">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                    </svg>
                    {group.folder === "Root" ? "Root Folder" : group.folder}{" "}
                    <span className="group-count">({group.videos.length})</span>
                  </h3>
                  <VirtualizedVideoGrid
                    videos={group.videos}
                    onVideoSelect={handleVideoSelect}
                    onToggleFavorite={handleToggleFavorite}
                    selectedVideos={selectedVideos}
                    onToggleSelect={handleToggleSelect}
                    scrollParentRef={scrollParentRef}
                  />
                </div>
              ))}
            </div>
          ) : (
            <VirtualizedVideoGrid
              videos={filteredVideos}
              onVideoSelect={handleVideoSelect}
              onToggleFavorite={handleToggleFavorite}
              selectedVideos={selectedVideos}
              onToggleSelect={handleToggleSelect}
              scrollParentRef={scrollParentRef}
            />
          )
        ) : (
          <div className="empty-state">
            <div className="empty-icon">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="clapperboard-icon"
              >
                <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
                <path d="m6.2 5.3 3.1 3.9" />
                <path d="m12.4 3.4 3.1 4" />
                <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              </svg>
            </div>
            <h2>No Folder Selected</h2>
            <p>Select a folder to view your video clips</p>
            <button className="btn" data-glow onClick={handleSelectFolder}>
              Select Folder
            </button>
          </div>
        )}
      </div>
      {selectedVideos.size > 0 &&
        (() => {
          const selectedVideoObjects = videos.filter((v) =>
            selectedVideos.has(v.path)
          );
          const allFavorited = selectedVideoObjects.every(
            (video) => video.isFavorite
          );

          return (
            <div className="selection-action-bar">
              <div className="selection-info">
                <span className="selection-count">
                  {selectedVideos.size} selected
                </span>
                <button
                  className="deselect-all-btn"
                  onClick={handleDeselectAll}
                >
                  Clear
                </button>
              </div>
              <div className="selection-actions">
                <button
                  className="btn favorite-btn"
                  data-glow="yellow"
                  onClick={handleFavoriteSelected}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill={allFavorited ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </button>
                <button
                  className="btn trash-btn"
                  data-glow="red"
                  onClick={handleTrashSelected}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })()}
    </div>
  );
};

export default LibraryView;
