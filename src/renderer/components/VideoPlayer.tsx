import React, { useEffect, useRef, useState } from "react";
import {
  VideoColorSampler,
  ColorRGB,
  MultiZoneColors,
} from "../utils/colorSampler";
import TimelineControls from "./TimelineControls";
import "../styles/VideoPlayer.css";

interface VideoPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoPath: string;
  isPlaying: boolean;
  onTimeUpdate: () => void;
  onLoadedMetadata: () => void;
  onEnded: () => void;
  onColorChange?: (colors: MultiZoneColors) => void;
  playerRef?: React.RefObject<HTMLDivElement | null>;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  currentTime?: number;
  duration?: number;
  onPlayPause?: () => void;
  onSeek?: (time: number) => void;
  trimStart?: number;
  trimEnd?: number;
  onSkipToStart?: () => void;
  onSkipToEnd?: () => void;
  hasAudioTracks?: boolean;
  onMasterVolumeChange?: (volume: number) => void;
  masterVolume?: number;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({
  videoRef,
  videoPath,
  isPlaying,
  onTimeUpdate,
  onLoadedMetadata,
  onEnded,
  onColorChange,
  playerRef,
  isFullscreen = false,
  onToggleFullscreen,
  currentTime = 0,
  duration = 0,
  onPlayPause,
  onSeek,
  trimStart = 0,
  trimEnd = 0,
  onSkipToStart,
  onSkipToEnd,
  hasAudioTracks = false,
  onMasterVolumeChange,
  masterVolume = 1.0,
}) => {
  const internalPlayerRef = useRef<HTMLDivElement>(null);
  const actualPlayerRef = playerRef || internalPlayerRef;
  const samplerRef = useRef<VideoColorSampler | null>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const [isHovered, setIsHovered] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    samplerRef.current = new VideoColorSampler();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!onColorChange) return;

    let intervalId: NodeJS.Timeout;
    let sampleCount = 0;

    const sampleColors = () => {
      if (videoRef.current && samplerRef.current) {
        try {
          const colors = samplerRef.current.sampleMultiZoneColors(
            videoRef.current
          );
          onColorChange(colors);
          sampleCount++;
          if (sampleCount % 10 === 0) {
            console.log("🎨 Sample", sampleCount, "colors:", colors.average);
          }
        } catch (error) {
          console.error("Error sampling colors:", error);
        }
      }
    };

    intervalId = setInterval(sampleColors, 100);

    setTimeout(sampleColors, 100);

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [videoRef, onColorChange]);

  const handleVideoLoad = () => {
    onLoadedMetadata();

    const attemptSample = (attempts = 0) => {
      if (attempts > 10) return;

      setTimeout(() => {
        if (videoRef.current && samplerRef.current && onColorChange) {
          const colors = samplerRef.current.sampleMultiZoneColors(
            videoRef.current
          );
          onColorChange(colors);

          if (
            colors.average.r === 15 &&
            colors.average.g === 15 &&
            colors.average.b === 15 &&
            attempts < 5
          ) {
            attemptSample(attempts + 1);
          }
        }
      }, 50 * (attempts + 1));
    };

    attemptSample();
  };

  useEffect(() => {
    if (isHovered && !isFullscreen && onToggleFullscreen) {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
      hideTimeoutRef.current = setTimeout(() => {
        setIsHovered(false);
      }, 3000);
    }

    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, [isHovered, isFullscreen, onToggleFullscreen]);

  useEffect(() => {
    if (videoRef.current) {
      // Mute video if audio tracks are being played separately
      videoRef.current.muted = hasAudioTracks;
    }
  }, [hasAudioTracks, videoRef]);

  const handleError = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    const video = e.currentTarget;
    console.error("[VideoPlayer] Video error:", {
      error: video.error,
      code: video.error?.code,
      message: video.error?.message,
      networkState: video.networkState,
      readyState: video.readyState,
      src: video.src,
    });
  };

  return (
    <div
      className="video-player"
      ref={actualPlayerRef}
      onMouseEnter={() => {
        if (!isFullscreen) {
          setIsHovered(true);
          if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
          }
        }
      }}
      onMouseMove={() => {
        if (!isFullscreen) {
          setIsHovered(true);
          if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
          }
        }
      }}
      onMouseLeave={() => {
        if (!isFullscreen) {
          setIsHovered(false);
        }
      }}
    >
      <video
        ref={videoRef}
        src={window.path.toLocalURL(videoPath)}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={handleVideoLoad}
        onEnded={onEnded}
        onError={handleError}
        controls={false}
        muted={false}
        crossOrigin="anonymous"
      />
      <div className={`video-hover-controls ${isHovered ? "visible" : ""}`}>
        {onPlayPause && onSeek && duration > 0 && (
          <TimelineControls
            currentTime={currentTime}
            duration={duration}
            isPlaying={isPlaying}
            onPlayPause={onPlayPause}
            onSeek={onSeek}
            onSkipToStart={onSkipToStart}
              onSkipToEnd={onSkipToEnd}
              onToggleFullscreen={onToggleFullscreen}
              isFullscreen={isFullscreen}
              videoRef={videoRef}
              hasAudioTracks={hasAudioTracks}
              onMasterVolumeChange={onMasterVolumeChange}
              masterVolume={masterVolume}
            />
        )}
      </div>
    </div>
  );
};

export default VideoPlayer;
