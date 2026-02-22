from setuptools import setup, find_packages

setup(
    name="anybrowse",
    version="0.1.0",
    description="Python SDK for the anybrowse agent-to-agent registry",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    author="anybrowse",
    author_email="hello@anybrowse.dev",
    url="https://github.com/anybrowse/anybrowse-python",
    packages=find_packages(),
    install_requires=[
        "requests>=2.28.0",
    ],
    python_requires=">=3.8",
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Libraries :: Python Modules",
    ],
    keywords="mcp agent ai registry tools anybrowse",
)
