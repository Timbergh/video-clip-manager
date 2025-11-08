import React, { useState, useRef, useEffect } from "react";
import TimelineControls from "./TimelineControls";
import "../styles/FullscreenControls.css";

interface FullscreenControlsProps {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onExitFullscreen: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  trimStart?: number;
  trimEnd?: number;
  onSkipToStart?: () => void;
  onSkipToEnd?: () => void;
  hasAudioTracks?: boolean;
  onMasterVolumeChange?: (volume: number) => void;
  masterVolume?: number;
}

const FullscreenControls: React.FC<FullscreenControlsProps> = ({
  currentTime,
  duration,
  isPlaying,
  onPlayPause,
  onSeek,
  onExitFullscreen,
  videoRef,
  trimStart = 0,
  trimEnd = 0,
  onSkipToStart,
  onSkipToEnd,
  hasAudioTracks = false,
  onMasterVolumeChange,
  masterVolume = 1.0,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const canShowControlsRef = useRef(false);

  useEffect(() => {
    if (videoRef.current) {
      // Mute video if audio tracks are being played separately
      videoRef.current.muted = hasAudioTracks;
    }
  }, [hasAudioTracks, videoRef]);

  // Global mouse move listener for fullscreen hover detection
  useEffect(() => {
    // Delay before controls can be shown to prevent immediate visibility on fullscreen entry
    const enableTimeout = setTimeout(() => {
      canShowControlsRef.current = true;
    }, 500);

    const handleMouseMove = () => {
      // Only show controls if enough time has passed since mount
      if (!canShowControlsRef.current) {
        return;
      }

      setIsHovered(true);
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
      hideTimeoutRef.current = setTimeout(() => {
        setIsHovered(false);
      }, 3000);
    };

    // Add global listener when component mounts
    document.addEventListener("mousemove", handleMouseMove);

    // Start with controls hidden
    setIsHovered(false);

    return () => {
      clearTimeout(enableTimeout);
      document.removeEventListener("mousemove", handleMouseMove);
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className={`fullscreen-controls ${isHovered ? "visible" : ""}`}>
      <TimelineControls
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        onPlayPause={onPlayPause}
        onSeek={onSeek}
        onSkipToStart={onSkipToStart}
        onSkipToEnd={onSkipToEnd}
        onToggleFullscreen={onExitFullscreen}
        isFullscreen={true}
        videoRef={videoRef}
        hasAudioTracks={hasAudioTracks}
        onMasterVolumeChange={onMasterVolumeChange}
        masterVolume={masterVolume}
      />
    </div>
  );
};

export default FullscreenControls;

