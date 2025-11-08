import React, { useRef, useEffect, useState, useCallback } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { VideoFile, VideoFileWithMetadata } from "../types";
import "../styles/VideoGrid.css";
import LazyThumbnail from "./LazyThumbnail";

interface VirtualizedVideoGridProps {
  videos: VideoFile[] | VideoFileWithMetadata[];
  onVideoSelect: (video: VideoFile | VideoFileWithMetadata) => void;
  onToggleFavorite?: (video: VideoFileWithMetadata) => void;
  selectedVideos?: Set<string>;
  onToggleSelect?: (videoPath: string) => void;
  scrollParentRef?: React.RefObject<HTMLDivElement | null>;
}

interface VideoCardProps {
  video: VideoFile | VideoFileWithMetadata;
  onVideoSelect: (video: VideoFile | VideoFileWithMetadata) => void;
  onToggleFavorite?: (video: VideoFileWithMetadata) => void;
  isSelected: boolean;
  isFavorite: boolean;
  onToggleSelect?: (videoPath: string) => void;
  observerRoot?: HTMLDivElement | undefined;
}

const CARD_MIN_WIDTH = 280;
const CARD_GAP = 24;
const ROW_GAP = 24;

// VideoCard component
const VideoCard: React.FC<VideoCardProps> = ({
  video,
  onVideoSelect,
  onToggleFavorite,
  isSelected,
  isFavorite,
  onToggleSelect,
  observerRoot,
}) => {
  const videoWithMeta = video as VideoFileWithMetadata;
  const [isHovering, setIsHovering] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hasEndedRef = useRef(false);

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleFavorite) {
      onToggleFavorite(video as VideoFileWithMetadata);
    }
  };

  const handleSelectClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleSelect) {
      onToggleSelect(video.path);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  };

  const formatDuration = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, "0")}:${secs
        .toString()
        .padStart(2, "0")}`;
    }
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const formatDate = (date: Date): string => {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const hasTrimEdits =
    videoWithMeta.edits?.trimStart !== undefined &&
    videoWithMeta.edits?.trimEnd !== undefined &&
    (videoWithMeta.edits.trimStart > 0 || 
     (video.duration !== undefined && videoWithMeta.edits.trimEnd < video.duration));

  // Calculate thumbnail timestamp (matching main process logic)
  const getThumbnailTime = (): number => {
    if (hasTrimEdits && videoWithMeta.edits!.trimStart !== undefined) {
      return videoWithMeta.edits!.trimStart;
    } else if (video.duration !== undefined && video.duration > 0) {
      return video.duration / 2;
    }
    return 1;
  };

  const handleMouseEnter = () => {
    setIsHovering(true);
    // Delay showing preview by 500ms to avoid triggering on quick hovers
    hoverTimerRef.current = setTimeout(() => {
      // Only show preview if it hasn't ended yet
      if (!hasEndedRef.current) {
        setShowPreview(true);
      }
    }, 500);
  };

  const handleMouseLeave = () => {
    setIsHovering(false);
    setShowPreview(false);
    hasEndedRef.current = false; // Reset the ended flag
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  // Handle video preview playback
  useEffect(() => {
    if (!showPreview || !videoRef.current) return;

    // Reset ended flag when starting a new preview
    hasEndedRef.current = false;

    const videoElement = videoRef.current;
    const thumbnailTime = getThumbnailTime();
    const maxPlayTime = 10; // Maximum 10 seconds of preview
    let isMounted = true;

    const startPlayback = async () => {
      if (!isMounted) return;

      try {
        // Set the starting time
        videoElement.currentTime = thumbnailTime;

        // Try to play
        await videoElement.play();
        console.log("Preview playing from", thumbnailTime);
      } catch (error: any) {
        // Silently handle - some formats may not be supported
        if (error.name !== "AbortError") {
          console.log("Preview play error:", error.name, error.message);
        }
      }
    };

    // Handle video errors
    const handleError = (e: Event) => {
      const videoEl = e.target as HTMLVideoElement;
      console.error("[VideoPreview] Error loading:", video.name, {
        error: videoEl.error,
        code: videoEl.error?.code,
        message: videoEl.error?.message,
        networkState: videoEl.networkState,
        readyState: videoEl.readyState,
      });
    };

    // Stop video after 10 seconds
    const timeUpdateHandler = () => {
      if (videoElement.currentTime >= thumbnailTime + maxPlayTime) {
        videoElement.pause();
        videoElement.currentTime = thumbnailTime;
      }
    };

    // Handle video ending (if video is shorter than 10 seconds from start point)
    const handleEnded = () => {
      if (!isMounted) return;
      // Mark as ended and stop preview to show thumbnail again
      hasEndedRef.current = true;
      setShowPreview(false);
    };

    // Wait for video to be ready
    const handleCanPlay = () => {
      if (!isMounted) return;
      console.log("Video can play, starting preview for:", video.name);
      startPlayback();
    };

    const handleLoadedMetadata = () => {
      console.log(
        "Video metadata loaded for:",
        video.name,
        "duration:",
        videoElement.duration
      );
    };

    // Add event handlers
    videoElement.addEventListener("error", handleError);
    videoElement.addEventListener("loadedmetadata", handleLoadedMetadata, {
      once: true,
    });
    videoElement.addEventListener("ended", handleEnded);

    // Check if already ready
    if (videoElement.readyState >= 3) {
      // HAVE_FUTURE_DATA or better
      console.log("Video already ready, starting preview for:", video.name);
      startPlayback();
    } else {
      videoElement.addEventListener("canplay", handleCanPlay, { once: true });
    }

    videoElement.addEventListener("timeupdate", timeUpdateHandler);

    return () => {
      isMounted = false;
      videoElement.removeEventListener("error", handleError);
      videoElement.removeEventListener("loadedmetadata", handleLoadedMetadata);
      videoElement.removeEventListener("canplay", handleCanPlay);
      videoElement.removeEventListener("timeupdate", timeUpdateHandler);
      videoElement.removeEventListener("ended", handleEnded);
      videoElement.pause();
    };
  }, [showPreview]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);
  const displayDuration =
    video.duration !== undefined
      ? hasTrimEdits
        ? videoWithMeta.edits!.trimEnd! - videoWithMeta.edits!.trimStart!
        : video.duration
      : 0;

  return (
    <div
      className="video-card"
      onClick={() => onVideoSelect(video)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="clip-thumbnail">
        {showPreview && (
          <video
            ref={videoRef}
            className="video-preview"
            src={window.path.toLocalURL(video.path)}
            muted={true}
            playsInline
            preload="metadata"
            crossOrigin="anonymous"
          />
        )}
        <LazyThumbnail
          className="clip-thumbnail"
          videoPath={video.path}
          alt={video.name}
          placeholder={
            <div className="thumbnail-placeholder">
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
          }
          observerRoot={observerRoot}
          duration={video.duration}
          trimStart={videoWithMeta.edits?.trimStart}
          trimEnd={videoWithMeta.edits?.trimEnd}
        >
          {video.duration !== undefined && (
            <div className={`duration-badge ${hasTrimEdits ? "trimmed" : ""}`}>
              {hasTrimEdits && (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ marginRight: "4px" }}
                >
                  <circle cx="6" cy="6" r="3" />
                  <path d="M8.12 8.12 12 12" />
                  <path d="M20 4 8.12 15.88" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M14.8 14.8 20 20" />
                </svg>
              )}
              {formatDuration(displayDuration)}
            </div>
          )}
        </LazyThumbnail>
        <button
          className={`favorite-button ${isFavorite ? "favorited" : ""}`}
          onClick={handleFavoriteClick}
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill={isFavorite ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>
        {onToggleSelect && (
          <button
            className={`select-button ${isSelected ? "selected" : ""}`}
            onClick={handleSelectClick}
            title={isSelected ? "Deselect" : "Select"}
          >
            {isSelected ? (
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
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
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
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              </svg>
            )}
          </button>
        )}
      </div>

      <div className="video-info">
        <h3 className="video-name" title={video.name}>
          {video.name}
        </h3>
        <div className="video-meta">
          <span className="meta-item">
            <svg
              className="meta-icon"
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 2v4" />
              <path d="M16 2v4" />
              <rect width="18" height="18" x="3" y="4" rx="2" />
              <path d="M3 10h18" />
            </svg>
            {formatDate(video.created)}
          </span>
          <span className="meta-item">
            <svg
              className="meta-icon"
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
              <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
              <path d="M7 3v4a1 1 0 0 0 1 1h7" />
            </svg>
            {formatFileSize(video.size)}
          </span>
        </div>
      </div>
    </div>
  );
};

// Dynamic height calculation based on CSS values
const getCardHeight = (containerWidth: number): number => {
  // Base thumbnail height from CSS
  let thumbnailHeight = 180; // Default from CSS

  // Responsive thumbnail heights matching CSS breakpoints
  if (containerWidth <= 480) {
    thumbnailHeight = 140;
  } else if (containerWidth <= 768) {
    thumbnailHeight = 160;
  } else if (containerWidth >= 1200) {
    thumbnailHeight = 200;
  }

  // Video info section height: padding (18px * 2) + name height (~20px) + meta height (~20px) + margins
  const videoInfoHeight = 18 + 20 + 12 + 20 + 18; // ~88px total

  return thumbnailHeight + videoInfoHeight;
};

const VirtualizedVideoGrid: React.FC<VirtualizedVideoGridProps> = ({
  videos,
  onVideoSelect,
  onToggleFavorite,
  selectedVideos,
  onToggleSelect,
  scrollParentRef,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [columnsPerRow, setColumnsPerRow] = useState(1);

  // Stabilize observerRoot to prevent unnecessary re-renders
  const observerRoot = scrollParentRef?.current || undefined;

  // Calculate columns per row based on container width
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const width = containerRef.current.offsetWidth;
        setContainerWidth(width);

        // Calculate how many columns can fit
        const cols = Math.max(
          1,
          Math.floor((width + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP))
        );
        setColumnsPerRow(cols);
      }
    };

    updateDimensions();

    // Use ResizeObserver for better performance than window resize
    const resizeObserver = new ResizeObserver(updateDimensions);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    window.addEventListener("resize", updateDimensions);
    return () => {
      window.removeEventListener("resize", updateDimensions);
      resizeObserver.disconnect();
    };
  }, []);

  // Calculate total number of rows needed
  const rowCount = Math.ceil(videos.length / columnsPerRow);

  // Row renderer - render cards for this row
  const renderRow = (index: number, style: React.CSSProperties) => {
    const startIndex = index * columnsPerRow;
    const endIndex = Math.min(startIndex + columnsPerRow, videos.length);

    return (
      <div style={style}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${columnsPerRow}, 1fr)`,
            gap: `${CARD_GAP}px`,
            padding: "0 10px",
          }}
        >
          {videos.slice(startIndex, endIndex).map((video) => {
            const isSelected = selectedVideos?.has(video.path) || false;
            const videoWithMeta = video as VideoFileWithMetadata;
            return (
              <VideoCard
                key={video.path}
                video={video}
                onVideoSelect={onVideoSelect}
                onToggleFavorite={onToggleFavorite}
                isSelected={isSelected}
                isFavorite={videoWithMeta.isFavorite || false}
                onToggleSelect={onToggleSelect}
                observerRoot={observerRoot}
              />
            );
          })}
        </div>
      </div>
    );
  };

  // IMPORTANT: All hooks must be called before any early returns
  // This ensures hooks are called in the same order on every render
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    estimateSize: () => getCardHeight(containerWidth) + ROW_GAP,
    overscan: 4,
    getScrollElement: () => (scrollParentRef ? scrollParentRef.current : null),
  });

  if (videos.length === 0) {
    return (
      <div className="empty-grid">
        <p>No videos found in this folder</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="virtualized-grid-container"
      style={{ width: "100%" }}
    >
      <div
        style={{
          position: "relative",
          height: rowVirtualizer.getTotalSize(),
          width: "100%",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow: VirtualItem) => {
          const cardHeight = getCardHeight(containerWidth);
          return (
            <div
              key={virtualRow.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translate3d(0, ${virtualRow.start}px, 0)`,
                height: cardHeight + ROW_GAP,
              }}
            >
              {renderRow(virtualRow.index, { height: cardHeight })}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default VirtualizedVideoGrid;
