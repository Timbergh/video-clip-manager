import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import VideoPlayer from "../components/VideoPlayer";
import Timeline from "../components/Timeline";
import VideoInfoPanel from "../components/VideoInfoPanel";
import ExportPanel from "../components/ExportPanel";
import FullscreenControls from "../components/FullscreenControls";
import { useGlowEffect } from "../hooks/useGlowEffect";
import {
  VideoFile,
  AudioTrack,
  VideoMetadata,
  ClipEdits,
  AudioTrackEdit,
} from "../types";
import {
  ColorRGB,
  MultiZoneColors,
  VideoColorSampler,
} from "../utils/colorSampler";
import "../styles/EditorView.css";
import WindowControls from "../components/WindowControls";

const api = window.api;

const AUDIO_TRACK_COLORS = [
  "#22d3ee",
  "#3b82f6",
  "#f59e0b",
  "#ef4444",
  "#10b981",
  "#ec4899",
];

const EditorView: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const video = (location.state as any)?.video as VideoFile;

  // Initialize glow effect system
  useGlowEffect();

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [isLoadingAudio, setIsLoadingAudio] = useState(true);
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(true);
  const [loadingFadingOut, setLoadingFadingOut] = useState(false);
  const [audioBuffers, setAudioBuffers] = useState<AudioBuffer[]>([]);
  const [currentColors, setCurrentColors] = useState<MultiZoneColors>({
    center: { r: 15, g: 15, b: 15 },
    topLeft: { r: 15, g: 15, b: 15 },
    topRight: { r: 15, g: 15, b: 15 },
    bottomLeft: { r: 15, g: 15, b: 15 },
    bottomRight: { r: 15, g: 15, b: 15 },
    average: { r: 15, g: 15, b: 15 },
  });
  const [targetColors, setTargetColors] = useState<MultiZoneColors>({
    center: { r: 15, g: 15, b: 15 },
    topLeft: { r: 15, g: 15, b: 15 },
    topRight: { r: 15, g: 15, b: 15 },
    bottomLeft: { r: 15, g: 15, b: 15 },
    bottomRight: { r: 15, g: 15, b: 15 },
    average: { r: 15, g: 15, b: 15 },
  });
  const [gradientCenter, setGradientCenter] = useState({ x: 50, y: 45 });
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [contentHash, setContentHash] = useState<string>("");
  const [isFavorite, setIsFavorite] = useState(false);
  const [masterVolume, setMasterVolume] = useState(1.0);
  const [editsLoaded, setEditsLoaded] = useState(false);
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [timelineHeight, setTimelineHeight] = useState<number | null>(null);
  const [isResizingTimeline, setIsResizingTimeline] = useState(false);
  const resizeStartYRef = useRef<number>(0);
  const resizeStartHeightRef = useRef<number>(0);
  const timelineBottomRef = useRef<HTMLDivElement>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoPlayerRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const gainNodesRef = useRef<GainNode[]>([]);
  const audioStartTimeRef = useRef<number>(0);
  const currentVolumesRef = useRef<number[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const lastUpdateTimeRef = useRef<number>(0);

  const formatTimeDisplay = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  useEffect(() => {
    if (!video) {
      // Show black overlay and hide light rays immediately
      if ((window as any).__showOverlay) {
        (window as any).__showOverlay();
      }

      navigate("/");
      return;
    }

    loadClipData();
  }, [video]);

  useEffect(() => {
    if ((window as any).__hideOverlay) {
      (window as any).__hideOverlay();
    }
  }, []);

  useEffect(() => {
    if (!isLoadingAudio && showLoadingIndicator) {
      setLoadingFadingOut(true);

      const timer = setTimeout(() => {
        setShowLoadingIndicator(false);
        setLoadingFadingOut(false);
      }, 150);

      return () => clearTimeout(timer);
    }
  }, [isLoadingAudio, showLoadingIndicator]);

  const loadClipData = async () => {
    try {
      const meta: VideoMetadata = await api.getCachedMetadata(video.path);
      setMetadata(meta);

      const audioDuration = meta.format.duration || 0;
      setDuration(audioDuration);

      const hash = await api.getClipHash(video.path, audioDuration);
      setContentHash(hash);

      const defaultTracks: AudioTrack[] = meta.streams
        .filter((stream: any) => stream.codec_type === "audio")
        .map((stream: any, index: number) => ({
          index,
          name: stream.tags?.title || `Audio Track ${index + 1}`,
          volume: 1.0,
          color: AUDIO_TRACK_COLORS[index % AUDIO_TRACK_COLORS.length],
          isMuted: false,
        }));

      setAudioTracks(defaultTracks);
      currentVolumesRef.current = defaultTracks.map((t) => t.volume);
      setTrimEnd(audioDuration);

      const [favorite, savedEdits] = await Promise.all([
        api.isFavorite(hash),
        api.getClipEdits(hash),
      ]);

      setIsFavorite(favorite);

      if (savedEdits) {
        if (savedEdits.trimStart !== undefined) {
          setTrimStart(savedEdits.trimStart);
        }
        if (savedEdits.trimEnd !== undefined) {
          setTrimEnd(savedEdits.trimEnd);
        }

        if (savedEdits.audioTracks && savedEdits.audioTracks.length > 0) {
          const tracksWithSavedSettings = defaultTracks.map((track) => {
            const savedTrack = savedEdits.audioTracks?.find(
              (t: any) => t.index === track.index
            );
            if (savedTrack) {
              return {
                ...track,
                volume: savedTrack.volume,
                isMuted: savedTrack.isMuted,
              };
            }
            return track;
          });
          setAudioTracks(tracksWithSavedSettings);
          currentVolumesRef.current = savedEdits.audioTracks.map(
            (t: any) => t.volume
          );
        }
      }

      setEditsLoaded(true);

      if (defaultTracks.length > 0) {
        extractAndLoadAudio().finally(() => {
          setIsLoadingAudio(false);
        });
      } else {
        setIsLoadingAudio(false);
      }
    } catch (error) {
      console.error("Error loading clip data:", error);
      setEditsLoaded(true);
      setIsLoadingAudio(false);
    }
  };

  const loadVideoMetadata = async () => {};

  const extractAndLoadAudio = async (retryCount = 0) => {
    const MAX_RETRIES = 2;
    let success = false;

    try {
      // Pass forceRefresh=true if this is a retry
      const extractedFiles: string[] = await api.getCachedExtractedAudio(
        video.path,
        retryCount > 0
      );

      if (extractedFiles.length === 0) {
        success = true;
        return;
      }

      // Create Audio Context ONLY for decoding (will create new one for playback in user gesture)
      const AudioContext =
        window.AudioContext || (window as any).webkitAudioContext;
      const tempAudioContext = new AudioContext();

      // Load all audio buffers in parallel for better performance
      const bufferPromises = extractedFiles.map(async (file) => {
        try {
          const fileBuffer = await api.readFileBuffer(file);
          const sourceBuffer = fileBuffer.buffer.slice(
            fileBuffer.byteOffset,
            fileBuffer.byteOffset + fileBuffer.byteLength
          );
          let arrayBuffer: ArrayBuffer;
          if (sourceBuffer instanceof ArrayBuffer) {
            arrayBuffer = sourceBuffer;
          } else {
            // Convert SharedArrayBuffer to ArrayBuffer
            arrayBuffer = new ArrayBuffer(sourceBuffer.byteLength);
            new Uint8Array(arrayBuffer).set(new Uint8Array(sourceBuffer));
          }
          const audioBuffer = await tempAudioContext.decodeAudioData(
            arrayBuffer
          );
          return audioBuffer;
        } catch (error) {
          console.error(`Error loading audio file ${file}:`, error);
          return null;
        }
      });

      const buffers = (await Promise.all(bufferPromises)).filter(
        (b): b is AudioBuffer => b !== null
      );

      // Close the temporary context - we'll create a new one in user gesture
      await tempAudioContext.close();

      setAudioBuffers(buffers);
      success = true;
    } catch (error) {
      console.error("Error extracting/loading audio:", error);

      // Retry with force refresh if we haven't exceeded max retries
      if (retryCount < MAX_RETRIES) {
        console.log(
          `[Audio Extract] Retrying (attempt ${
            retryCount + 1
          }/${MAX_RETRIES})...`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second before retry
        return extractAndLoadAudio(retryCount + 1);
      } else {
        console.error("[Audio Extract] Max retries exceeded, giving up");
      }
    } finally {
      // Only set loading to false if we succeeded or exhausted retries
      if (success || retryCount >= MAX_RETRIES) {
        setIsLoadingAudio(false);
      }
    }
  };

  const handlePlayPause = async () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
        stopAudio();
        setIsPlaying(false);
      } else {
        try {
          let audioResumePromise: Promise<void> | null = null;

          // Create AudioContext if it doesn't exist (do this early in user gesture)
          if (!audioContextRef.current) {
            const AudioContext =
              window.AudioContext || (window as any).webkitAudioContext;
            audioContextRef.current = new AudioContext();
          }

          // Resume immediately (still in user gesture context)
          if (audioContextRef.current.state !== "running") {
            audioResumePromise = audioContextRef.current.resume();
          }

          // Now do async operations
          await videoRef.current.play();

          // Wait for audio resume to complete
          if (audioResumePromise) {
            await audioResumePromise;
          }

          // Start audio if buffers are ready
          if (
            audioBuffers.length > 0 &&
            audioContextRef.current &&
            audioContextRef.current.state === "running"
          ) {
            await startAudio();
          }

          setIsPlaying(true);
        } catch (error) {
          console.error("[PlayPause] Error starting playback:", error);
        }
      }
    }
  };

  const startAudio = async () => {
    if (
      !audioContextRef.current ||
      audioBuffers.length === 0 ||
      !videoRef.current
    ) {
      return;
    }

    const audioContext = audioContextRef.current;
    const currentVideoTime = videoRef.current.currentTime;

    // Stop any existing playback
    stopAudio();

    const sources: AudioBufferSourceNode[] = [];
    const gains: GainNode[] = [];

    // Create and start a source for each audio buffer
    audioBuffers.forEach((buffer, bufferIndex) => {
      const source = audioContext.createBufferSource();
      source.buffer = buffer;

      const gainNode = audioContext.createGain();
      // Use currentVolumesRef which is always up-to-date
      const volume = currentVolumesRef.current[bufferIndex] ?? 1.0;
      const track = audioTracks[bufferIndex];
      const effectiveVolume = track?.isMuted ? 0 : volume;
      // Apply master volume to all tracks
      gainNode.gain.value = effectiveVolume * masterVolume;

      source.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Start from current video position
      source.start(0, currentVideoTime);

      sources.push(source);
      gains.push(gainNode);
    });

    audioSourcesRef.current = sources;
    gainNodesRef.current = gains;
    audioStartTimeRef.current = audioContext.currentTime - currentVideoTime;
  };

  const stopAudio = () => {
    audioSourcesRef.current.forEach((source, index) => {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Already stopped
      }
    });
    audioSourcesRef.current = [];
    gainNodesRef.current = [];
  };

  const handleSeek = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);

      // Restart audio from new position if playing
      if (isPlaying) {
        stopAudio();
        setTimeout(async () => {
          await startAudio();
        }, 50);
      }
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  // High-frequency time update for smooth playhead movement
  const updateTimeSmoothly = () => {
    if (videoRef.current && isPlaying) {
      const now = performance.now();
      // Update at 60fps (every ~16.67ms) for smooth movement
      if (now - lastUpdateTimeRef.current >= 16.67) {
        setCurrentTime(videoRef.current.currentTime);
        lastUpdateTimeRef.current = now;
      }
      animationFrameRef.current = requestAnimationFrame(updateTimeSmoothly);
    }
  };

  // Start/stop smooth time updates based on play state
  useEffect(() => {
    if (isPlaying) {
      lastUpdateTimeRef.current = performance.now();
      animationFrameRef.current = requestAnimationFrame(updateTimeSmoothly);
    } else {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isPlaying]);

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      const dur = videoRef.current.duration;
      setDuration(dur);
      if (trimEnd === 0) {
        setTrimEnd(dur);
      }

      // Mute video if audio tracks are being played separately
      if (audioBuffers.length > 0) {
        videoRef.current.muted = true;
      }

      // Seek to trim start if it's set
      if (trimStart > 0) {
        videoRef.current.currentTime = trimStart;
      }
    }
  };

  const handleSkipToTrimStart = () => {
    handleSeek(trimStart);
  };

  const handleSkipToTrimEnd = () => {
    handleSeek(trimEnd);
  };

  const handleVideoEnded = () => {
    if (videoRef.current) {
      videoRef.current.pause();
    }
    stopAudio();
    setIsPlaying(false);
  };

  const handleVolumeChange = (trackIndex: number, volume: number) => {
    // Update state for UI
    setAudioTracks((prev) => {
      const updated = prev.map((track) =>
        track.index === trackIndex ? { ...track, volume } : track
      );
      return updated;
    });

    // Update the ref immediately so it's available for next startAudio() call
    const arrayIndex = trackIndex;
    currentVolumesRef.current[arrayIndex] = volume;

    // Apply volume change in real-time to the gain node (if audio is playing)
    if (gainNodesRef.current[arrayIndex]) {
      const track = audioTracks.find((t) => t.index === trackIndex);
      const effectiveVolume = track?.isMuted ? 0 : volume;
      // Apply master volume
      gainNodesRef.current[arrayIndex].gain.value = effectiveVolume * masterVolume;
    }
  };

  // Update master volume and apply to all gain nodes
  const handleMasterVolumeChange = (volume: number) => {
    setMasterVolume(volume);
    // Apply to all currently playing gain nodes
    gainNodesRef.current.forEach((gainNode, index) => {
      const track = audioTracks[index];
      const trackVolume = currentVolumesRef.current[index] ?? 1.0;
      const effectiveVolume = track?.isMuted ? 0 : trackVolume;
      gainNode.gain.value = effectiveVolume * volume;
    });
  };

  const handleMuteToggle = (trackIndex: number) => {
    // Update state for UI
    setAudioTracks((prev) => {
      const updated = prev.map((track) =>
        track.index === trackIndex
          ? { ...track, isMuted: !track.isMuted }
          : track
      );

      // Apply mute in real-time to the gain node (if audio is playing)
      const arrayIndex = trackIndex;
      if (gainNodesRef.current[arrayIndex]) {
        const updatedTrack = updated.find((t) => t.index === trackIndex);
        const effectiveVolume = updatedTrack?.isMuted
          ? 0
          : updatedTrack?.volume ?? 1.0;
        // Apply master volume
        gainNodesRef.current[arrayIndex].gain.value = effectiveVolume * masterVolume;
      }

      return updated;
    });
  };

  // Save edits to database
  const saveEdits = async () => {
    if (!contentHash || !editsLoaded) return;

    try {
      const edits: ClipEdits = {};

      // Only save trim if not at 100% (default)
      const isTrimAtDefault = trimStart === 0 && trimEnd === duration;
      if (!isTrimAtDefault) {
        edits.trimStart = trimStart;
        edits.trimEnd = trimEnd;
      }

      // Only save audio tracks if any are modified from default
      const hasModifiedAudio = audioTracks.some(
        (track) => track.volume !== 1.0 || track.isMuted
      );
      if (hasModifiedAudio) {
        edits.audioTracks = audioTracks.map((track) => ({
          index: track.index,
          volume: track.volume,
          isMuted: track.isMuted,
        }));
      }

      await api.saveClipEdits({
        contentHash,
        filepath: video.path,
        fileSize: video.size,
        duration: duration || null,
        edits,
      });

      console.log("[EditorView] Saved edits:", edits);
    } catch (error) {
      console.error("Error saving edits:", error);
    }
  };

  // Toggle favorite status
  const handleToggleFavorite = async () => {
    if (!contentHash) return;

    try {
      const result = await api.toggleFavorite({
        contentHash,
        filepath: video.path,
        fileSize: video.size,
        duration: duration || null,
      });

      setIsFavorite(result.isFavorite);
      console.log(
        `[EditorView] Toggled favorite: ${result.isFavorite ? "ON" : "OFF"}`
      );
    } catch (error) {
      console.error("Error toggling favorite:", error);
    }
  };

  // Auto-save edits when trim points or audio tracks change (debounced)
  useEffect(() => {
    if (!editsLoaded) return;

    // Clear existing timer
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    // Set new timer
    saveTimerRef.current = setTimeout(() => {
      saveEdits();
    }, 500);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [trimStart, trimEnd, audioTracks, editsLoaded, contentHash]);

  // Mute video when audio tracks are loaded
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = audioBuffers.length > 0;
    }
  }, [audioBuffers.length]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Save edits one last time before unmounting
      if (editsLoaded && contentHash) {
        saveEdits();
      }

      stopAudio();
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  const handleToggleFullscreen = React.useCallback(async () => {
    if (!isFullscreen) {
      try {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
      } catch (error) {
        console.error("Error entering fullscreen:", error);
      }
    } else {
      try {
        await document.exitFullscreen();
        setIsFullscreen(false);
      } catch (error) {
        console.error("Error exiting fullscreen:", error);
      }
    }
  }, [isFullscreen]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input field
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (!videoRef.current) return;

      const fps = 30;
      const frameDuration = 1 / fps;

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          // Await to maintain user gesture context
          void handlePlayPause();
          break;
        case "f":
          e.preventDefault();
          void handleToggleFullscreen();
          break;
        case "Escape":
          if (isFullscreen) {
            e.preventDefault();
            void handleToggleFullscreen();
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          handleSeek(Math.max(0, currentTime - 5));
          break;
        case "ArrowRight":
          e.preventDefault();
          handleSeek(Math.min(duration, currentTime + 5));
          break;
        case "j":
          e.preventDefault();
          handleSeek(Math.max(0, currentTime - 15));
          break;
        case "l":
          e.preventDefault();
          handleSeek(Math.min(duration, currentTime + 15));
          break;
        case ",":
          e.preventDefault();
          handleSeek(Math.max(0, currentTime - frameDuration));
          break;
        case ".":
          e.preventDefault();
          handleSeek(Math.min(duration, currentTime + frameDuration));
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [currentTime, duration, isPlaying, isFullscreen, handlePlayPause, handleSeek, handleToggleFullscreen]);

  const handleBack = () => {
    // Show black overlay and hide light rays immediately
    if ((window as any).__showOverlay) {
      (window as any).__showOverlay();
    }

    navigate("/");
  };

  const handleDeleteVideo = async () => {
    if (!video) return;

    const confirmed = confirm(
      `Are you sure you want to delete "${video.name}"? This will move it to trash.`
    );
    if (!confirmed) return;

    try {
      await api.trashFiles([video.path]);
      // Show black overlay and hide light rays immediately
      if ((window as any).__showOverlay) {
        (window as any).__showOverlay();
      }
      navigate("/");
    } catch (error) {
      console.error("Error deleting video:", error);
      alert("Failed to delete video. See console for details.");
    }
  };

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const handleColorChange = (colors: MultiZoneColors) => {
    setTargetColors(colors);
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingTimeline(true);
    resizeStartYRef.current = e.clientY;
    // Get current height from DOM if using natural sizing
    const currentHeight =
      timelineHeight ?? timelineBottomRef.current?.offsetHeight ?? 250;
    resizeStartHeightRef.current = currentHeight;
  };

  const handleResizeMove = (e: MouseEvent) => {
    if (!isResizingTimeline) return;

    const deltaY = resizeStartYRef.current - e.clientY;
    // Minimum: controls (60) + ruler (36) + at least one track visible (38) = 134px
    const minHeight = 134;
    const newHeight = Math.max(
      minHeight,
      Math.min(600, resizeStartHeightRef.current + deltaY)
    );
    setTimelineHeight(newHeight);
  };

  const handleResizeEnd = () => {
    if (isResizingTimeline) {
      setIsResizingTimeline(false);
    }
  };

  const handleResizeDoubleClick = () => {
    // Reset to natural height
    setTimelineHeight(null);
  };

  // Timeline resize event listeners
  useEffect(() => {
    if (isResizingTimeline) {
      document.addEventListener("mousemove", handleResizeMove);
      document.addEventListener("mouseup", handleResizeEnd);
      return () => {
        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeEnd);
      };
    }
  }, [isResizingTimeline, timelineHeight]);

  // Smooth color interpolation for all zones - faster updates
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentColors((prev) => {
        const progress = 0.2; // Faster color transitions
        return {
          center: VideoColorSampler.interpolateColor(
            prev.center,
            targetColors.center,
            progress
          ),
          topLeft: VideoColorSampler.interpolateColor(
            prev.topLeft,
            targetColors.topLeft,
            progress
          ),
          topRight: VideoColorSampler.interpolateColor(
            prev.topRight,
            targetColors.topRight,
            progress
          ),
          bottomLeft: VideoColorSampler.interpolateColor(
            prev.bottomLeft,
            targetColors.bottomLeft,
            progress
          ),
          bottomRight: VideoColorSampler.interpolateColor(
            prev.bottomRight,
            targetColors.bottomRight,
            progress
          ),
          average: VideoColorSampler.interpolateColor(
            prev.average,
            targetColors.average,
            progress
          ),
        };
      });
    }, 30); // Update more frequently

    return () => clearInterval(interval);
  }, [targetColors]);

  // Calculate gradient center based on video player position
  useEffect(() => {
    const updateGradientCenter = () => {
      if (videoPlayerRef.current) {
        const rect = videoPlayerRef.current.getBoundingClientRect();
        const centerX =
          ((rect.left + rect.width / 2) / window.innerWidth) * 100;
        const centerY =
          ((rect.top + rect.height / 2) / window.innerHeight) * 100;
        setGradientCenter({ x: centerX, y: centerY });
      }
    };

    updateGradientCenter();
    window.addEventListener("resize", updateGradientCenter);

    // Update after a brief delay to ensure layout is settled
    const timeoutId = setTimeout(updateGradientCenter, 100);

    return () => {
      window.removeEventListener("resize", updateGradientCenter);
      clearTimeout(timeoutId);
    };
  }, []);

  if (!video) {
    return null;
  }

  // Dynamic background styles - multi-zone gradient centered on video
  // Using multiple overlapping gradients for better corner coverage
  const { center, topLeft, topRight, bottomLeft, bottomRight, average } =
    currentColors;

  const backgroundStyle = {
    background: `
      radial-gradient(circle at ${gradientCenter.x}% ${gradientCenter.y}%, 
        rgba(${center.r}, ${center.g}, ${center.b}, 0.7) 0%, 
        rgba(${center.r}, ${center.g}, ${center.b}, 0.5) 20%, 
        transparent 60%),
      radial-gradient(ellipse 120% 100% at ${gradientCenter.x}% ${
      gradientCenter.y
    }%, 
        rgba(${average.r}, ${average.g}, ${average.b}, 0.5) 0%, 
        rgba(${average.r}, ${average.g}, ${average.b}, 0.35) 25%, 
        rgba(${Math.floor(
          (topLeft.r + topRight.r + bottomLeft.r + bottomRight.r) / 4
        )}, ${Math.floor(
      (topLeft.g + topRight.g + bottomLeft.g + bottomRight.g) / 4
    )}, ${Math.floor(
      (topLeft.b + topRight.b + bottomLeft.b + bottomRight.b) / 4
    )}, 0.2) 50%, 
        rgba(${Math.floor(average.r * 0.6)}, ${Math.floor(
      average.g * 0.6
    )}, ${Math.floor(average.b * 0.6)}, 0.1) 70%, 
        rgba(12, 12, 15, 1) 100%),
      linear-gradient(135deg,
        rgba(${topLeft.r}, ${topLeft.g}, ${topLeft.b}, 0.15) 0%,
        transparent 30%,
        transparent 70%,
        rgba(${bottomRight.r}, ${bottomRight.g}, ${bottomRight.b}, 0.15) 100%),
      linear-gradient(45deg,
        rgba(${bottomLeft.r}, ${bottomLeft.g}, ${bottomLeft.b}, 0.12) 0%,
        transparent 30%,
        transparent 70%,
        rgba(${topRight.r}, ${topRight.g}, ${topRight.b}, 0.12) 100%),
      rgb(12, 12, 15)
    `
      .replace(/\s+/g, " ")
      .trim(),
  };

  return (
    <div
      className={`editor-view ${isResizingTimeline ? "resizing-timeline" : ""} ${
        isFullscreen ? "fullscreen" : ""
      }`}
      style={backgroundStyle}
    >
      <div className="editor-view-overlay"></div>
      <header className="editor-header">
        <button className="btn back-btn no-drag" onClick={handleBack} data-glow>
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
            className="back-btn-icon"
          >
            <path d="M13 9a1 1 0 0 1-1-1V5.061a1 1 0 0 0-1.811-.75l-6.835 6.836a1.207 1.207 0 0 0 0 1.707l6.835 6.835a1 1 0 0 0 1.811-.75V16a1 1 0 0 1 1-1h6a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1z" />
          </svg>
          Back to Library
        </button>
        <h2 className="video-title">{video.name}</h2>
        <div className="header-actions">
          <button
            className="btn header-export-btn no-drag"
            onClick={() => setShowExportPanel(true)}
            data-glow
          >
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
            >
              <path d="M12 15V3" />
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="m7 10 5 5 5-5" />
            </svg>
            Export
          </button>
          {!isFullscreen && <WindowControls />}
        </div>
      </header>

      <div className="editor-content">
        <div className="editor-top">
          <div className="editor-main">
            <VideoPlayer
              videoRef={videoRef}
              videoPath={video.path}
              isPlaying={isPlaying}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onEnded={handleVideoEnded}
              onColorChange={handleColorChange}
              playerRef={videoPlayerRef}
              isFullscreen={isFullscreen}
              onToggleFullscreen={handleToggleFullscreen}
              currentTime={currentTime}
              duration={duration}
              onPlayPause={handlePlayPause}
              onSeek={handleSeek}
              trimStart={trimStart}
              trimEnd={trimEnd}
              onSkipToStart={handleSkipToTrimStart}
              onSkipToEnd={handleSkipToTrimEnd}
              hasAudioTracks={audioBuffers.length > 0}
              onMasterVolumeChange={handleMasterVolumeChange}
              masterVolume={masterVolume}
            />
            {isFullscreen && (
              <FullscreenControls
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                onPlayPause={handlePlayPause}
                onSeek={handleSeek}
                onExitFullscreen={handleToggleFullscreen}
                videoRef={videoRef}
                trimStart={trimStart}
                trimEnd={trimEnd}
                onSkipToStart={handleSkipToTrimStart}
                onSkipToEnd={handleSkipToTrimEnd}
                hasAudioTracks={audioBuffers.length > 0}
                onMasterVolumeChange={handleMasterVolumeChange}
                masterVolume={masterVolume}
              />
            )}
          </div>

          {!isFullscreen && (
            <div className="editor-sidebar">
              <VideoInfoPanel
                videoName={video.name}
                videoPath={video.path}
                metadata={metadata}
                trimStart={trimStart}
                trimEnd={trimEnd}
                isFavorite={isFavorite}
                onToggleFavorite={handleToggleFavorite}
                onDelete={handleDeleteVideo}
              />
            </div>
          )}
        </div>

        {!isFullscreen && (
          <div
            ref={timelineBottomRef}
            className="timeline-bottom"
            style={timelineHeight ? { height: `${timelineHeight}px` } : {}}
          >
          <div
            className={`timeline-resize-handle ${
              isResizingTimeline ? "active" : ""
            }`}
            onMouseDown={handleResizeStart}
            onDoubleClick={handleResizeDoubleClick}
            title="Drag to resize • Double-click to reset"
          >
            <div className="resize-handle-bar"></div>
          </div>
          <div className="timeline-controls">
            <div className="playback-controls">
              <button
                className="control-btn btn"
                onClick={handleSkipToTrimStart}
                title="Skip to Start"
                data-glow="tiny"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="play-control-btn-icon"
                >
                  <path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z" />
                  <path d="M3 20V4" />
                </svg>
              </button>
              <button
                className="control-btn play-btn btn"
                onClick={handlePlayPause}
                title={isPlaying ? "Pause" : "Play"}
                data-glow="tiny"
              >
                {isPlaying ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="play-control-btn-icon"
                  >
                    <rect x="14" y="3" width="5" height="18" rx="1" />
                    <rect x="5" y="3" width="5" height="18" rx="1" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="play-control-btn-icon"
                  >
                    <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
                  </svg>
                )}
              </button>
              <button
                className="control-btn btn"
                onClick={handleSkipToTrimEnd}
                title="Skip to End"
                data-glow="tiny"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="play-control-btn-icon"
                >
                  <path d="M21 4v16" />
                  <path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z" />
                </svg>
              </button>
            </div>
          </div>

          <Timeline
            duration={duration}
            currentTime={currentTime}
            trimStart={trimStart}
            trimEnd={trimEnd}
            onSeek={handleSeek}
            onTrimStartChange={setTrimStart}
            onTrimEndChange={setTrimEnd}
            videoPath={video.path}
            audioTracks={audioTracks}
            audioBuffers={audioBuffers}
            onVolumeChange={handleVolumeChange}
            onMuteToggle={handleMuteToggle}
          />
          </div>
        )}
      </div>

      {showLoadingIndicator && (
        <div
          className={`audio-loading-indicator ${
            loadingFadingOut ? "fade-out" : ""
          }`}
        >
          <div className="loading-spinner"></div>
          <span className="loading-text">Loading clip data...</span>
        </div>
      )}

      {showExportPanel && (
        <div
          className="export-modal-overlay"
          onClick={() => setShowExportPanel(false)}
        >
          <div className="export-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="btn close-btn"
              onClick={() => setShowExportPanel(false)}
              data-glow="tiny"
            >
              ×
            </button>
            <ExportPanel
              videoPath={video.path}
              videoName={video.name}
              trimStart={trimStart}
              trimEnd={trimEnd}
              audioTracks={audioTracks}
              onClose={() => setShowExportPanel(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default EditorView;
