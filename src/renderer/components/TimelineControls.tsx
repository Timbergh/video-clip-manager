import React, { useState, useRef, useEffect, useCallback } from "react";
import "../styles/TimelineControls.css";

interface TimelineControlsProps {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSkipToStart?: () => void;
  onSkipToEnd?: () => void;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  hasAudioTracks?: boolean;
  onMasterVolumeChange?: (volume: number) => void;
  masterVolume?: number;
}

const TimelineControls: React.FC<TimelineControlsProps> = ({
  currentTime,
  duration,
  isPlaying,
  onPlayPause,
  onSeek,
  onSkipToStart,
  onSkipToEnd,
  onToggleFullscreen,
  isFullscreen = false,
  videoRef,
  hasAudioTracks = false,
  onMasterVolumeChange,
  masterVolume = 1.0,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [volume, setVolume] = useState(masterVolume);
  const timelineRef = useRef<HTMLDivElement>(null);
  const isUserChangingVolumeRef = useRef(false);
  const lastMasterVolumeRef = useRef(masterVolume);
  const volumeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize volume from prop when component mounts or prop changes externally
  useEffect(() => {
    // Only sync if masterVolume changed externally (not from our own update)
    if (!isUserChangingVolumeRef.current && Math.abs(lastMasterVolumeRef.current - masterVolume) > 0.001) {
      setVolume(masterVolume);
      lastMasterVolumeRef.current = masterVolume;
    }
  }, [masterVolume]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (volumeTimeoutRef.current) {
        clearTimeout(volumeTimeoutRef.current);
      }
    };
  }, []);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const getTimeFromPosition = (clientX: number): number => {
    if (!timelineRef.current) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    return percentage * duration;
  };

  const handleTimelineMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    const time = getTimeFromPosition(e.clientX);
    onSeek(time);
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (isDragging && timelineRef.current) {
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, x / rect.width));
      const time = percentage * duration;
      onSeek(time);
    }
  }, [isDragging, duration, onSeek]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Apply volume changes to video element (only when no audio tracks)
  useEffect(() => {
    if (!hasAudioTracks && videoRef.current && !isUserChangingVolumeRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = false;
    }
  }, [volume, videoRef, hasAudioTracks]);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    isUserChangingVolumeRef.current = true;
    setVolume(newVolume);
    lastMasterVolumeRef.current = newVolume;
    
    // Clear any pending timeout
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current);
    }
    
    // Immediately apply the change
    if (hasAudioTracks && onMasterVolumeChange) {
      onMasterVolumeChange(newVolume);
    } else if (videoRef.current) {
      videoRef.current.volume = newVolume;
      videoRef.current.muted = false;
    }
    
    // Reset flag after a delay to allow prop sync if needed
    volumeTimeoutRef.current = setTimeout(() => {
      isUserChangingVolumeRef.current = false;
      volumeTimeoutRef.current = null;
    }, 100);
  };

  const currentPercentage = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="timeline-controls-container">
      <div
        ref={timelineRef}
        className="timeline-controls-timeline"
        onMouseDown={handleTimelineMouseDown}
      >
        <div className="timeline-controls-track">
          <div
            className="timeline-controls-progress"
            style={{ width: `${currentPercentage}%` }}
          />
        </div>
      </div>

      <div className="timeline-controls-row">
        {onSkipToStart && (
          <button
            className="timeline-controls-seek-btn"
            onClick={onSkipToStart}
            title="Skip to Start"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z" />
              <path d="M3 20V4" />
            </svg>
          </button>
        )}

        <button
          className="timeline-controls-play-btn"
          onClick={onPlayPause}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="14" y="3" width="5" height="18" rx="1" />
              <rect x="5" y="3" width="5" height="18" rx="1" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
            </svg>
          )}
        </button>

        {onSkipToEnd && (
          <button
            className="timeline-controls-seek-btn"
            onClick={onSkipToEnd}
            title="Skip to End"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 4v16" />
              <path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z" />
            </svg>
          </button>
        )}

        <div className="timeline-controls-time-display">
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>

        <div className="timeline-controls-volume">
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
            <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
            <path d="M16 9a5 5 0 0 1 0 6" />
            <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
          </svg>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={handleVolumeChange}
            className="timeline-controls-volume-slider"
            title="Preview Volume"
          />
        </div>

        {onToggleFullscreen && (
          <button
            className="timeline-controls-fullscreen-btn"
            onClick={onToggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen (Esc)" : "Enter Fullscreen (F)"}
          >
            {isFullscreen ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
};

export default TimelineControls;

