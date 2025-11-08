import React, { useState } from "react";
import { VideoMetadata } from "../types";
import { useGlowEffect } from "../hooks/useGlowEffect";
import "../styles/VideoInfoPanel.css";

interface VideoInfoPanelProps {
  videoName: string;
  videoPath: string;
  metadata: VideoMetadata | null;
  trimStart: number;
  trimEnd: number;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onDelete?: () => void;
}

const VideoInfoPanel: React.FC<VideoInfoPanelProps> = ({
  videoName,
  videoPath,
  metadata,
  trimStart,
  trimEnd,
  isFavorite,
  onToggleFavorite,
  onDelete,
}) => {
  // Initialize glow effect system
  useGlowEffect();

  const [isCollapsed, setIsCollapsed] = useState(false);

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return "N/A";
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(2)} KB`;
  };

  const formatBitrate = (bitrate?: number): string => {
    if (!bitrate) return "N/A";
    const mbps = bitrate / 1000000;
    return `${mbps.toFixed(2)} Mbps`;
  };

  const formatTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, "0")}:${secs
        .toString()
        .padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
    }
    return `${mins}:${secs.toString().padStart(2, "0")}.${ms
      .toString()
      .padStart(2, "0")}`;
  };

  const getVideoInfo = () => {
    if (!metadata) return null;
    const videoStream = metadata.streams.find((s) => s.codec_type === "video");
    return videoStream;
  };

  const videoInfo = getVideoInfo();
  const duration = metadata?.format.duration || 0;
  const trimDuration = trimEnd - trimStart;

  return (
    <div
      className={`video-info-panel-wrapper ${isCollapsed ? "collapsed" : ""}`}
    >
      <button
        className="collapse-toggle btn"
        onClick={() => setIsCollapsed(!isCollapsed)}
        aria-label={isCollapsed ? "Expand panel" : "Collapse panel"}
        data-glow="tiny"
      >
        {isCollapsed ? (
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
            <path d="m9 6-6 6 6 6" />
            <path d="M3 12h14" />
            <path d="M21 19V5" />
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
            <path d="M3 5v14" />
            <path d="M21 12H7" />
            <path d="m15 18 6-6-6-6" />
          </svg>
        )}
      </button>

      <div className="video-info-panel">
        {!isCollapsed && (
          <div className="panel-content">
            <div className="panel-section clip-details">
              <div className="section-header">
                <h3>CLIP DETAILS</h3>
              </div>

              <div className="properties-grid">
                <div className="property-item">
                  <span className="property-label">Title</span>
                  <span className="property-value title-with-star">
                    <span className="title-text">{videoName}</span>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill={isFavorite ? "currentColor" : "none"}
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`favorite-star ${
                        isFavorite ? "favorited" : ""
                      }`}
                      onClick={onToggleFavorite}
                    >
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                    {onDelete && (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="delete-icon"
                        onClick={onDelete}
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                    )}
                  </span>
                </div>

                <div className="property-item">
                  <span className="property-label">Resolution</span>
                  <span className="property-value">
                    {videoInfo?.width && videoInfo?.height
                      ? `${videoInfo.width}x${videoInfo.height}`
                      : "N/A"}
                  </span>
                </div>

                <div className="property-item">
                  <span className="property-label">Codec</span>
                  <span className="property-value">
                    {videoInfo?.codec_name?.toUpperCase() || "N/A"}
                  </span>
                </div>

                <div className="property-item">
                  <span className="property-label">Duration</span>
                  <span className="property-value">{formatTime(duration)}</span>
                </div>

                <div className="property-item">
                  <span className="property-label">File Size</span>
                  <span className="property-value">
                    {formatFileSize(metadata?.format.size)}
                  </span>
                </div>

                <div className="property-item">
                  <span className="property-label">Bitrate</span>
                  <span className="property-value">
                    {formatBitrate(metadata?.format.bit_rate)}
                  </span>
                </div>

                <div className="property-item">
                  <span className="property-label">Trim Start</span>
                  <span className="property-value">
                    {formatTime(trimStart)}
                  </span>
                </div>

                <div className="property-item">
                  <span className="property-label">Trim End</span>
                  <span className="property-value">{formatTime(trimEnd)}</span>
                </div>

                <div className="property-item">
                  <span className="property-label">Trim Duration</span>
                  <span className="property-value highlight">
                    {formatTime(trimDuration)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoInfoPanel;
